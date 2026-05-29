from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_theme_provider_forces_light_mode_and_ignores_stored_dark_preference():
    src = read("src/contexts/ThemeContext.tsx")

    assert 'const FORCED_THEME: Theme = "light"' in src
    assert 'root.classList.remove("dark")' in src
    assert 'localStorage.setItem("theme", FORCED_THEME)' in src
    assert 'matchMedia("(prefers-color-scheme: dark)")' not in src
    assert 'root.classList.add("dark")' not in src


def test_settings_dark_mode_control_is_temporarily_disabled():
    src = read("src/pages/Settings.tsx")

    assert 'Tạm thời tắt để tập trung phát triển light mode' in src
    assert 'Light mode' in src
    assert 'checked={theme === "dark"}' not in src
    assert 'onCheckedChange={toggleTheme}' not in src


def test_new_brand_logo_is_used_for_sidebar_and_browser_tab():
    sidebar = read("src/components/layout/Sidebar.tsx")
    html = read("index.html")

    assert 'import bmqLogo from "@/assets/bmq-logo.png"' in sidebar
    assert '<img src={bmqLogo}' in sidebar
    assert '/assets/brand/bmq-logo-512.png?v=2' in html
    assert '/assets/brand/bmq-logo-favicon.ico?v=2' in html
    assert (ROOT / "src/assets/bmq-logo.png").is_file()
    assert (ROOT / "public/assets/brand/bmq-logo-512.png").is_file()
    assert (ROOT / "public/assets/brand/bmq-logo-favicon.ico").is_file()
