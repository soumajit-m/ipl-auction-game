/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: '#090B10',
        tile: '#12151E',
        tileHover: '#161C2A',
        subpill: '#1C202E',
        subpillHover: '#222B40',
        borderDark: '#232B3E',
        borderMuted: '#1E2638',
        iosCard: '#12151E',
        iosElevated: '#1C202E',
        iosActive: '#2C3246',
        brand: {
          gold: '#E5A93C',
          goldMuted: '#9B7126',
          emerald: '#10B981',
          rose: '#EF4444',
          cyan: '#06B6D4',
          blue: '#3B82F6',
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace']
      }
    },
  },
  plugins: [],
}
