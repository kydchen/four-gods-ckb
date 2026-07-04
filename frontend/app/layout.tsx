"use client";
import { ccc } from "@ckb-ccc/connector-react";
import { getClient } from "@/lib/client";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ccc.Provider defaultClient={getClient()}>{children}</ccc.Provider>
      </body>
    </html>
  );
}
