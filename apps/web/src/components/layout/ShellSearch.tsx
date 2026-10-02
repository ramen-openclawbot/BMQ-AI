import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { openAgentChat, useShellNav } from "./useShellNav";

/** Vietnamese labels match without diacritics too ("duyet chi" finds "Duyệt chi"). */
const fold = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/** Every typed word must appear in the label (accents optional); the whole phrase ranks first. */
const filterFunctions = (value: string, search: string, keywords: string[] = []) => {
  const haystack = fold([value, ...keywords].join(" "));
  const query = fold(search).trim();
  if (!query) return 1;
  if (!query.split(/\s+/).every((word) => haystack.includes(word))) return 0;
  return haystack.includes(query) ? 1 : 0.5;
};

interface ShellSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Jump to any page the user may open. ⌘K / Ctrl+K toggles it. */
export function ShellSearch({ open, onOpenChange }: ShellSearchProps) {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { zones, utilities, agentChatEnabled, label, language } = useShellNav();
  const en = language === "en";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  const groups = [
    ...zones.filter(({ zone }) => zone.id !== "ai").map(({ zone, pages }) => ({ key: zone.id, heading: label(zone.label), pages })),
    ...utilities.map(({ group, pages }) => ({ key: group.label.vi, heading: label(group.label), pages })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="d3-search-dialog overflow-hidden p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{en ? "Search functions" : "Tìm chức năng"}</DialogTitle>
        <Command filter={filterFunctions}>
          <CommandInput placeholder={en ? "Type a function name…" : "Gõ tên chức năng…"} />
          <CommandList className="max-h-[min(60vh,420px)]">
            <CommandEmpty>{en ? "No matching function." : "Không có chức năng phù hợp."}</CommandEmpty>
            {agentChatEnabled && (
              <CommandGroup heading="AI">
                <CommandItem
                  value="ask-ai"
                  keywords={["hoi ai", "ask ai", "vnagent", "chat"]}
                  onSelect={() => {
                    onOpenChange(false);
                    openAgentChat();
                  }}
                >
                  <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
                  {en ? "Ask BMQ AI" : "Hỏi BMQ AI"}
                </CommandItem>
              </CommandGroup>
            )}
            {groups.map((group) => (
              <CommandGroup key={group.key} heading={group.heading}>
                {group.pages.map((page) => {
                  const text = t[page.labelKey];
                  return (
                    <CommandItem
                      key={page.path}
                      value={`${group.key} ${page.path}`}
                      keywords={[text, fold(text), group.heading, fold(group.heading)]}
                      onSelect={() => go(page.path)}
                    >
                      <page.icon className="mr-2 h-4 w-4" aria-hidden="true" />
                      {text}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
