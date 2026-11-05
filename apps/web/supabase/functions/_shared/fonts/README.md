# Noto Sans Vietnamese PDF fonts

The original files are used by the `production-material-issue-pdf` Supabase Edge Function. The `-vi` copies are used by the BMQ dealer-signup PDF Edge Functions so Vietnamese A4 PDFs render without fetching fonts at runtime. The `-vi` copies are trimmed to the characters used by Vietnamese contracts; the original upstream TTFs are kept unchanged for reference and can regenerate them.

Source: Google Fonts / Noto Fonts GitHub repository:
- https://github.com/googlefonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf
- https://github.com/googlefonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf

License: SIL Open Font License 1.1, as published in the Noto Fonts repository.

## Regenerating the `-vi` subsets

Run from this directory with python3 + fontTools installed (`pip install fonttools brotli`):

```sh
for base in NotoSans-Regular NotoSans-Bold; do
  pyftsubset "$base.ttf" \
    --output-file="$base-vi.ttf" \
    --unicodes="U+0000-007F,U+0080-00FF,U+0100-017F,U+0180-024F,U+1E00-1EFF,U+0300-036F,U+2000-206F,U+20A0-20BF" \
    --glyph-names \
    --symbol-cmap \
    --legacy-cmap \
    --notdef-glyph \
    --notdef-outline \
    --recommended-glyphs \
    --name-IDs="*" \
    --name-legacy \
    --name-languages="*" \
    --layout-features="*" \
    --no-hinting
done
```

The ranges cover Basic Latin, Latin-1 Supplement, Latin Extended-A, Latin Extended-B, Latin Extended Additional (Vietnamese diacritics, U+1E00-1EFF), combining diacritics (U+0300-036F), general punctuation (U+2000-206F) and currency symbols including ₫ (U+20AB). Embedded with `subset: false` because the files are already small.
