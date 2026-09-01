import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Dark-first: the app is used in kitchens, restaurants and at night.
        ink: { DEFAULT: "#0b0b0d", soft: "#16161a", line: "#26262c" },
        macro: {
          kcal: "#f4a261",
          protein: "#2a9d8f",
          carbs: "#8ab4f8",
          fat: "#e76f51",
        },
      },
      // Respect the Android status bar / gesture area on a home-screen PWA.
      spacing: { safe: "env(safe-area-inset-bottom)" },
    },
  },
  plugins: [],
} satisfies Config;
