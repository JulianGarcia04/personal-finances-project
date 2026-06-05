/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#080c14',
        surface: {
          DEFAULT: '#0f172a',
          glass: 'rgba(15, 23, 42, 0.65)',
        },
        border: 'rgba(255, 255, 255, 0.06)',
        accent: {
          emerald: '#10b981',
          emeraldHover: '#059669',
          rose: '#f43f5e',
          roseHover: '#e11d48',
          amber: '#fbbf24',
          amberHover: '#d97706',
          violet: '#8b5cf6',
        },
        text: {
          primary: '#f8fafc',
          secondary: '#94a3b8',
          muted: '#64748b',
        }
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'sans-serif'],
        display: ['Outfit', 'sans-serif'],
      },
      boxShadow: {
        'glow-emerald': '0 0 20px rgba(16, 185, 129, 0.12)',
        'glow-rose': '0 0 20px rgba(244, 63, 94, 0.12)',
        'glow-amber': '0 0 20px rgba(251, 191, 36, 0.12)',
        'glass': '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
      },
      backdropBlur: {
        'xs': '2px',
      }
    },
  },
  plugins: [],
}
