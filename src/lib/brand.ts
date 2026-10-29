// The Lynor symbol on a 64-unit grid: two identical leaves mirrored across the
// diagonal cut, so the gap between them is even. public/favicon.svg and the PWA
// icons are drawn from these same paths.
export const LYNOR_MARK_PATHS = [
  'M10 24.5Q10 22 12.14 20.71L27.86 11.29Q30 10 30 12.5L30 29.5Q30 32 28.23 33.77L11.77 50.23Q10 52 10 49.5Z',
  'M39.5 54Q42 54 43.29 51.86L52.71 36.14Q54 34 51.5 34L34.5 34Q32 34 30.23 35.77L13.77 52.23Q12 54 14.5 54Z'
] as const

// Violet at the inner corner to cyan at both tips, along the symbol's diagonal.
export const LYNOR_MARK_GRADIENT = {
  from: { x: 10, y: 54 },
  to: { x: 42, y: 22 },
  stops: [
    { offset: 0, color: '#5A12FE' },
    { offset: 0.5, color: '#2056FD' },
    { offset: 1, color: '#00C2FD' }
  ]
} as const
