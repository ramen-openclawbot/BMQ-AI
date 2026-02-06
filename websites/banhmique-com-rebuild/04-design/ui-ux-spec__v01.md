# BMQ WEBSITE UI/UX SPEC - Rebuild v01

## 1. DESIGN SYSTEM

### Color Palette
```css
/* Primary Colors */
--primary-main: #2E7D32;        /* Forest Green - fresh, natural */
--primary-light: #4CAF50;       /* Vibrant Green */
--primary-dark: #1B5E20;        /* Deep Forest */

/* Secondary Colors */
--secondary-main: #FF6B35;      /* Warm Orange - appetite, energy */
--secondary-light: #FF8A65;     /* Soft Orange */
--secondary-dark: #E55100;      /* Burnt Orange */

/* Neutral Palette */
--neutral-100: #FFFFFF;         /* Pure White */
--neutral-200: #F8F9FA;         /* Off White */
--neutral-300: #E9ECEF;         /* Light Gray */
--neutral-400: #DEE2E6;         /* Medium Light */
--neutral-500: #6C757D;         /* Medium Gray */
--neutral-600: #495057;         /* Dark Gray */
--neutral-700: #343A40;         /* Almost Black */
--neutral-800: #212529;         /* Rich Black */

/* Semantic Colors */
--success: #28A745;             /* Success Green */
--warning: #FFC107;             /* Warning Amber */
--error: #DC3545;               /* Error Red */
--info: #17A2B8;                /* Info Blue */
```

### Typography Scale
```css
/* Font Family */
--font-primary: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
--font-secondary: 'Playfair Display', Georgia, serif;

/* Type Scale */
--text-xs: 0.75rem;     /* 12px */
--text-sm: 0.875rem;    /* 14px */
--text-base: 1rem;      /* 16px */
--text-lg: 1.125rem;    /* 18px */
--text-xl: 1.25rem;     /* 20px */
--text-2xl: 1.5rem;     /* 24px */
--text-3xl: 1.875rem;   /* 30px */
--text-4xl: 2.25rem;    /* 36px */
--text-5xl: 3rem;       /* 48px */

/* Font Weights */
--font-light: 300;
--font-regular: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
```

### Spacing System
```css
/* 8px Grid System */
--space-1: 0.5rem;    /* 8px */
--space-2: 1rem;      /* 16px */
--space-3: 1.5rem;    /* 24px */
--space-4: 2rem;      /* 32px */
--space-5: 2.5rem;    /* 40px */
--space-6: 3rem;      /* 48px */
--space-8: 4rem;      /* 64px */
--space-10: 5rem;     /* 80px */
--space-12: 6rem;     /* 96px */
```

### Border Radius
```css
--radius-sm: 0.25rem;   /* 4px */
--radius-md: 0.5rem;    /* 8px */
--radius-lg: 1rem;      /* 16px */
--radius-xl: 1.5rem;    /* 24px */
--radius-full: 9999px;  /* Full rounded */
```

### Shadows
```css
--shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
--shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
--shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
--shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
```

### Button Styles
```css
/* Primary Button */
.btn-primary {
  background: var(--primary-main);
  color: white;
  padding: 0.75rem 1.5rem;
  border-radius: var(--radius-lg);
  font-weight: var(--font-semibold);
  box-shadow: var(--shadow-md);
  transition: all 0.2s ease;
}
.btn-primary:hover {
  background: var(--primary-dark);
  box-shadow: var(--shadow-lg);
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: var(--secondary-main);
  color: white;
  padding: 0.75rem 1.5rem;
  border-radius: var(--radius-lg);
  font-weight: var(--font-semibold);
}

/* Outline Button */
.btn-outline {
  background: transparent;
  border: 2px solid var(--primary-main);
  color: var(--primary-main);
  padding: 0.75rem 1.5rem;
  border-radius: var(--radius-lg);
  font-weight: var(--font-semibold);
}
```

---

## 2. LAYOUT SPEC - HOME PAGE

### Header/Navigation
```
Structure:
- Logo BMQ (left) - height: 40px
- Main nav (center): Trang chủ | Sản phẩm | Cửa hàng | Về chúng tôi | Blog
- CTA (right): "Đặt hàng ngay" button
- Mobile: Hamburger menu + bottom sticky CTA

Styling:
- Background: white with subtle shadow
- Height: 80px desktop / 64px mobile
- Sticky on scroll with backdrop blur
- Active link: primary color underline
```

### Hero Section
```
Layout:
- Split layout: 60% content / 40% image
- Height: 80vh max
- Content order: Mobile - text first, image second

Content hierarchy:
1. Headline: Playfair Display, 3rem, bold
2. Subheadline: Inter, 1.25rem, regular
3. CTA buttons: Primary + Secondary
4. Trust badges: 3-4 icons with text

Visual elements:
- High-quality food photography
- Fresh ingredients styling
- Warm, natural lighting
- Subtle animated elements (leaves, steam)
```

### Product Highlights
```
Grid: 3 columns desktop → 1 column mobile
Card style: Rounded corners (16px), subtle shadow
Image: 16:9 ratio, hover zoom effect
Content: Title, short desc, price, CTA

Sections:
1. Bánh mì đặc biệt (flagship products)
2. Thực đơn mới (seasonal items)
3. Combo ưu đãi (value meals)
```

### Store Locator Teaser
```
Design: Map background with location pins
Content: "Tìm cửa hàng gần bạn" + ZIP code input
CTA: "Xem cửa hàng" → Full locator page
Visual: Minimalist map illustration, green pins
```

### Partner/Suppliers Section
```
Layout: Logo carousel (auto-scroll)
Title: "Đối tác tin cậy của chúng tôi"
Style: Grayscale logos on hover
Brands: High-quality ingredient suppliers
```

### News/Blog Highlights
```
Grid: 2x2 desktop → 1 column mobile
Cards: Featured image, category, title, excerpt, read time
CTA: "Xem thêm bài viết" → Blog page
Focus: Food trends, health tips, BMQ stories
```

### Final CTA
```
Design: Full-width banner, primary color background
Text: "Trải nghiệm Bánh Mì Que ngay hôm nay"
CTA: "Đặt hàng ngay" + "Tìm cửa hàng"
Style: High contrast, can't miss
```

---

## 3. COMPONENT SPECIFICATIONS

### Card Component
```css
.card {
  background: white;
  border-radius: var(--radius-xl);
  padding: var(--space-4);
  box-shadow: var(--shadow-md);
  transition: all 0.3s ease;
}
.card:hover {
  box-shadow: var(--shadow-xl);
  transform: translateY(-4px);
}
```

### Section Header
```css
.section-header {
  text-align: center;
  margin-bottom: var(--space-8);
}
.section-title {
  font-family: var(--font-secondary);
  font-size: var(--text-4xl);
  color: var(--neutral-700);
  margin-bottom: var(--space-2);
}
.section-subtitle {
  font-size: var(--text-lg);
  color: var(--neutral-500);
  max-width: 600px;
  margin: 0 auto;
}
```

### CTA Buttons
```css
/* Size variants */
.btn-small { padding: 0.5rem 1rem; font-size: var(--text-sm); }
.btn-medium { padding: 0.75rem 1.5rem; font-size: var(--text-base); }
.btn-large { padding: 1rem 2rem; font-size: var(--text-lg); }

/* Icon buttons */
.btn-icon {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
```

### Mobile Navigation
```
Structure:
- Full-screen overlay
- Close button (top right)
- Logo centered
- Menu items stacked
- Social links bottom
- CTA button sticky bottom

Animation: Slide from right, smooth transition
Background: White with subtle pattern
```

### Image Treatment
```css
/* Rounded corners for all images */
img {
  border-radius: var(--radius-lg);
}

/* Hero images - more rounded */
.hero-image {
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
}

/* Product images - clean, bright */
.product-image {
  background: var(--neutral-100);
  padding: var(--space-2);
  border: 1px solid var(--neutral-300);
}

/* Hover effects */
.image-hover {
  transition: transform 0.3s ease;
}
.image-hover:hover {
  transform: scale(1.05);
}
```

---

## 4. ASSETS & LOGO USAGE

### BMQ Logo Guidelines
```
Primary Logo:
- Use full color version on light backgrounds
- White version on dark backgrounds
- Minimum size: 120px width
- Clear space: 0.5x logo height on all sides

Logo Placement:
- Header: Left-aligned, 40px height
- Footer: Centered, 48px height
- Favicon: Simplified mark
- Social: Profile picture format
```

### Photography Style
```
Food Photography:
- Natural daylight or warm artificial light
- Fresh ingredients visible
- Steam/warmth indication
- Clean, simple backgrounds
- High contrast, vibrant colors

Lifestyle Shots:
- People enjoying food
- Modern, clean environments
- Vietnamese urban settings
- Happy, natural expressions
- Premium but approachable feel
```

### Icon Style
```
Style: Line icons, 2px stroke
Color: Primary green or neutral-600
Size: 20x20px for UI, 48x48px for features
Consistency: Rounded corners, same weight
Set: Use consistent icon family (Feather/Phosphor)
```

---

## 5. MOBILE-FIRST RESPONSIVE

### Breakpoints
```css
/* Mobile: 320px - 767px */
@media (max-width: 767px) { }

/* Tablet: 768px - 1023px */
@media (min-width: 768px) and (max-width: 1023px) { }

/* Desktop: 1024px+ */
@media (min-width: 1024px) { }
```

### Mobile Priorities
1. Sticky CTA button
2. Simplified navigation
3. Touch-friendly targets (min 44px)
4. Optimized images (WebP format)
5. Fast loading (Core Web Vitals)

---

## 6. ACCESSIBILITY & PERFORMANCE

### Accessibility
- WCAG 2.1 AA compliance
- Alt text for all images
- Keyboard navigation support
- Focus indicators visible
- Color contrast ratio 4.5:1 minimum

### Performance Targets
- First Contentful Paint: < 1.8s
- Largest Contentful Paint: < 2.5s
- First Input Delay: < 100ms
- Cumulative Layout Shift: < 0.1

---

## 7. IMPLEMENTATION NOTES

### CSS Structure (current modules)
```
src/
├── components/
│   ├── Button.module.css
│   ├── Card.module.css
│   ├── Navigation.module.css
│   └── Section.module.css
├── layouts/
│   ├── Header.module.css
│   ├── Footer.module.css
│   └── Home.module.css
└── styles/
    ├── globals.css
    ├── variables.css
    └── utilities.css
```

### Next.js Considerations
- Use CSS modules as currently implemented
- Consider CSS custom properties for theming
- Image optimization with Next.js Image component
- Font optimization with next/font

### Testing Checklist
- Cross-browser testing (Chrome, Safari, Firefox, Edge)
- Mobile device testing (iOS, Android)
- Screen reader compatibility
- Performance testing (Lighthouse score > 90)
- SEO validation

---

**Spec created for:** BMQ Website Rebuild v01
**Date:** $(date)
**Status:** Ready for implementation
**Next steps:** Component building → Page assembly → Testing → Launch