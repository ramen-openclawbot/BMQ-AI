import { createContext, useContext, useEffect, ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const FORCED_THEME: Theme = "light";

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark");
    root.dataset.theme = FORCED_THEME;
    localStorage.setItem("theme", FORCED_THEME);
  }, []);

  // Dark mode is intentionally disabled while the BMQ-AI light theme is being finalized.
  // Keep the public API stable so existing components do not need special-case guards.
  const enforceLightTheme = () => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.theme = FORCED_THEME;
    localStorage.setItem("theme", FORCED_THEME);
  };

  return (
    <ThemeContext.Provider
      value={{ theme: FORCED_THEME, toggleTheme: enforceLightTheme, setTheme: enforceLightTheme }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
