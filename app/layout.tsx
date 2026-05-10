import type { Metadata } from 'next'
import { AppErrorBoundary } from '@/AppErrorBoundary'
import { Providers } from './providers'
import '@/index.css'

export const metadata: Metadata = {
  title: 'Physio PlanungsApp',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="de">
      <body>
        <AppErrorBoundary>
          <Providers>{children}</Providers>
        </AppErrorBoundary>
      </body>
    </html>
  )
}
