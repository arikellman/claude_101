import Link from "next/link";

/**
 * The one "return" affordance used across every screen. Before this existed, the
 * top-right link read "Home" on five screens, "Back" on Trend, and "Cancel" on New
 * Recipe, with no shared sizing - none of them hit the 44px tap-target minimum
 * globals.css sets for buttons, because that rule only applies to <button>, not the
 * <Link>-rendered <a> every one of these actually was.
 */
export default function NavPill({
  href,
  label = "Home",
  className = "",
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`flex min-h-11 items-center justify-center rounded-full bg-ink-soft
                  px-4 text-xs text-neutral-300 ${className}`}
    >
      {label}
    </Link>
  );
}
