"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type * as React from "react";

export const Providers = ({ children }: { children: React.ReactNode }) => (
  <NextThemesProvider
    attribute="class"
    defaultTheme="system"
    disableTransitionOnChange
    enableColorScheme
    enableSystem
  >
    {children}
  </NextThemesProvider>
);
