/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/renderer/**/*.{html,ts,tsx}",
    "../../app-kernel/packages/app-plugins/src/**/*.{ts,tsx}",
  ],
  theme: { extend: {} },
  plugins: [],
};
