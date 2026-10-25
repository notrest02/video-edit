/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        editor: {
          bg: '#0f1117',
          panel: '#161922',
          border: '#262b38',
          hover: '#1f2430',
          accent: '#6366f1',
        }
      }
    },
  },
  plugins: [],
}
