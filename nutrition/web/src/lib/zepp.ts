/**
 * Zepp/Huami (Amazfit Helios) health-data pull. Server-only - this performs the same
 * login handshake the Zepp mobile app itself uses, which requires an email + password
 * and a fixed AES key that only makes sense to hold server-side.
 *
 * There is no official third-party API for this: Zepp does not offer OAuth to outside
 * apps. This reimplements a reverse-engineered login sequence (credit to the
 * actively-maintained github.com/argrento/huami-token, MIT licensed, for documenting
 * the AES-encrypted token exchange) and a handful of read-only data endpoints
 * (credit to github.com/m4ary/zepp-health-cli, MIT licensed, for documenting their
 * shapes). Neither project is affiliated with Zepp Health. Expect this to need
 * adjustment if Zepp changes their app's login sequence or API shape - it was last
 * verified working against a real Helios strap on 2026-08-17.
 *
 * Deliberately does NOT compute anything from the raw per-minute heart-rate byte array
 * (`data_hr`) in the band_data response - filtering its "no reading" sentinel bytes
 * correctly is unverified guesswork. Resting HR instead comes straight from `slp.rhr`,
 * a value Zepp's own algorithm already computed - same "transcribe, don't derive"
 * principle as the label-scan prompts in prompts.ts.
 */

import { createCipheriv, randomUUID } from "node:crypto";

const AES_KEY = Buffer.from("xeNtBVqzDc6tuNTh", "utf8");
const AES_IV = Buffer.from("MAAAYAAAAAAAAABg", "utf8");

const TOKENS_URL = "https://api-user-us2.zepp.com/v2/registrations/tokens";
const LOGIN_URL = "https://api-mifit-us2.zepp.com/v2/client/login";
const DEFAULT_HOST = "api-mifit-us2.zepp.com";

const TOKENS_HEADERS = {
  app_name: "com.huami.midong",
  appname: "com.huami.midong",
  cv: "151689_9.12.5",
  v: "2.0",
  appplatform: "android_phone",
  vb: "202509151347",
  vn: "9.12.5",
  "user-agent": "Zepp/9.12.5 (Pixel 4; Android 12; Density/2.75)",
  "x-hm-ekv": "1",
  "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
};

const LOGIN_HEADERS = {
  app_name: "com.huami.webapp",
  appname: "com.huami.webapp",
  origin: "https://user.zepp.com",
  referer: "https://user.zepp.com/",
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  accept: "application/json, text/plain, */*",
};

const DATA_HEADERS_BASE = {
  "hm-privacy-diagnostics": "false",
  country: "US",
  appplatform: "android_phone",
  "hm-privacy-ceip": "true",
  timezone: "Asia/Jerusalem",
  channel: "a100900101016",
  vb: "202509151347",
  cv: "151689_9.12.5",
  appname: "com.huami.midong",
  v: "2.0",
  vn: "9.12.5",
  lang: "en_US",
  "user-agent": "Zepp/9.12.5 (Pixel 4; Android 12; Density/2.75)",
};

function zeppEncrypt(plainBuf: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", AES_KEY, AES_IV);
  return Buffer.concat([cipher.update(plainBuf), cipher.final()]);
}

async function getAccessToken(email: string, password: string): Promise<string> {
  const params = new URLSearchParams();
  params.append("emailOrPhone", email);
  params.append("state", "REDIRECTION");
  params.append("client_id", "HuaMi");
  params.append("password", password);
  params.append("redirect_uri", "https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html");
  params.append("region", "us-west-2");
  params.append("token", "access");
  params.append("token", "refresh");
  params.append("country_code", "US");

  const encrypted = zeppEncrypt(Buffer.from(params.toString(), "utf8"));

  const res = await fetch(TOKENS_URL, {
    method: "POST",
    headers: TOKENS_HEADERS,
    body: new Uint8Array(encrypted),
    redirect: "manual",
  });

  if (res.status !== 303) {
    throw new Error(`Zepp login step 1 failed: expected 303, got ${res.status}`);
  }
  const location = res.headers.get("location");
  if (!location) throw new Error("Zepp login step 1: no Location header in redirect");

  const redirectUrl = new URL(location);
  const access = redirectUrl.searchParams.get("access");
  if (!access) throw new Error("Zepp login step 1: no access token in redirect URL");
  return access;
}

async function loginWithAccessToken(accessToken: string): Promise<{ appToken: string; userId: string }> {
  const params = new URLSearchParams({
    code: accessToken,
    device_id: randomUUID(),
    device_model: "android_phone",
    app_version: "9.12.5",
    dn: "api-mifit.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,auth.zepp.com,api-analytics.zepp.com",
    third_name: "huami",
    source: "com.huami.watch.hmwatchmanager:9.12.5:151689",
    app_name: "com.huami.midong",
    country_code: "US",
    grant_type: "access_token",
    allow_registration: "false",
    lang: "en",
    countryState: "US-NY",
  });

  const res = await fetch(LOGIN_URL, { method: "POST", headers: LOGIN_HEADERS, body: params.toString() });
  if (!res.ok) throw new Error(`Zepp login step 2 failed: ${res.status}`);
  const data = await res.json();
  const info = data.token_info;
  if (!info?.app_token || !info?.user_id) {
    throw new Error("Zepp login step 2: no app_token/user_id in response");
  }
  return { appToken: info.app_token as string, userId: String(info.user_id) };
}

interface RawBandDataDay {
  date_time: string;
  summary: string;
}

export interface WearableDay {
  date: string; // YYYY-MM-DD
  steps: number;
  activeCalories: number;
  sleepMinutes: number;
  deepSleepMinutes: number;
  /** null when nothing was recorded that day (band not worn, e.g. Shabbat), not 0. */
  restingHr: number | null;
}

/** Pure - decodes one day of the band_data.json response. No I/O, unit-testable. */
export function decodeBandDataDay(raw: RawBandDataDay): WearableDay {
  const summary = JSON.parse(Buffer.from(raw.summary, "base64").toString("utf8"));
  const stp = summary.stp ?? {};
  const slp = summary.slp ?? {};
  const rhr = typeof slp.rhr === "number" && slp.rhr > 0 ? slp.rhr : null;

  return {
    date: raw.date_time,
    steps: stp.ttl ?? 0,
    activeCalories: stp.cal ?? 0,
    sleepMinutes: (slp.lt ?? 0) + (slp.dp ?? 0),
    deepSleepMinutes: slp.dp ?? 0,
    restingHr: rhr,
  };
}

/**
 * Logs in fresh and pulls the last `days` of band data. No token caching - the
 * password-based login works end-to-end on every call, so there is nothing to persist
 * between runs and no ~30-day token expiry to manage.
 */
export async function fetchRecentWearableDays(
  email: string,
  password: string,
  days: number,
  host: string = DEFAULT_HOST
): Promise<WearableDay[]> {
  const access = await getAccessToken(email, password);
  const { appToken, userId } = await loginWithAccessToken(access);

  const toDate = isoDate(new Date());
  const fromDate = isoDate(new Date(Date.now() - days * 86_400_000));

  const url = new URL(`https://${host}/v1/data/band_data.json`);
  url.searchParams.set("userid", userId);
  url.searchParams.set("from_date", fromDate);
  url.searchParams.set("to_date", toDate);
  url.searchParams.set("query_type", "detail");
  url.searchParams.set("byteLength", "8");
  url.searchParams.set("device_type", "0");
  url.searchParams.set("r", randomUUID());

  const res = await fetch(url, {
    headers: { ...DATA_HEADERS_BASE, apptoken: appToken, "x-request-id": randomUUID() },
  });
  if (!res.ok) throw new Error(`band_data.json failed: ${res.status}`);
  const body = await res.json();
  if (body.code !== 1 && body.code !== 0) {
    throw new Error(`band_data.json returned code ${body.code}: ${body.message}`);
  }

  return ((body.data ?? []) as RawBandDataDay[])
    .map(decodeBandDataDay)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
