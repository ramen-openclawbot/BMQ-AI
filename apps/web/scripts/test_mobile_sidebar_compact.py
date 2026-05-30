from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIDEBAR = ROOT / "src/components/layout/Sidebar.tsx"
source = SIDEBAR.read_text(encoding="utf-8")

required_tokens = [
    'data-stitch-mobile-sidebar="compact-readable"',
    'space-y-0.5 overflow-y-auto px-3 py-3 pb-20',
    'text-sidebar-foreground/80',
    'text-[13px] font-bold',
    'h-10 items-center',
    'h-9 items-center',
    'before:w-0.5 before:rounded-full before:bg-sidebar-primary',
    'md:space-y-1 md:px-4 md:py-6 md:pb-24',
]

missing = [token for token in required_tokens if token not in source]
assert not missing, f"Missing compact mobile sidebar markers/classes: {missing}"

# Guard against drifting back to the previous airy mobile spacing while allowing desktop md: fallbacks.
forbidden_exact = [
    '<nav className="flex-1 px-4 py-6 pb-24 space-y-1 overflow-y-auto">',
    'className="px-4 py-4 border-t border-sidebar-border/60 pb-[max(1rem,env(safe-area-inset-bottom))] bg-sidebar/60 backdrop-blur-xl"',
    'className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-foreground/75 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground transition-all duration-200"',
]

present = [token for token in forbidden_exact if token in source]
assert not present, f"Old airy mobile sidebar classes came back: {present}"

print("mobile sidebar compact/readable theme guard passed")
