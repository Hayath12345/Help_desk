import localFont from 'next/font/local';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';

// Geist is loaded locally (files vendored from the `geist` package, OFL — see _fonts/GEIST-LICENSE.txt)
// with adjustFontFallback disabled. next/font's default size-adjusted Arial fallback covers every
// Unicode range, so it would catch Arabic glyphs before IBM Plex Sans Arabic in the stack below.
// Without it, Latin renders in Geist and Arabic falls through per glyph to IBM Plex Sans Arabic.
const geistSans = localFont({
  src: './_fonts/Geist-Variable.woff2',
  variable: '--font-geist-sans',
  weight: '100 900',
  display: 'swap',
  adjustFontFallback: false,
});

const geistMono = localFont({
  src: './_fonts/GeistMono-Variable.woff2',
  variable: '--font-geist-mono',
  weight: '100 900',
  display: 'swap',
  adjustFontFallback: false,
});

const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-arabic',
  display: 'swap',
});

export const fontVariables = [geistSans.variable, geistMono.variable, plexArabic.variable].join(' ');
