import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clipper',
  description: 'Personal YouTube auto-clipper',
};

const themeScript = `(function(){try{var t=localStorage.getItem('clip-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
