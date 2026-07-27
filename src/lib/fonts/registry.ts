/**
 * 字体注册表。
 *
 * 这里故意不使用 next/font/google：EXE 构建和离线启动不应该依赖
 * fonts.googleapis.com / fonts.gstatic.com。字体变量名保持不变，实际字体由
 * globals.css 中的本机字体栈提供，用户已有的字体选择和 UI 结构不受影响。
 */
interface StaticFont {
  variable: string;
  className: string;
}

function staticFont(variable: string, name: string): StaticFont {
  return {
    variable,
    className: `font-registry-${name}`,
  };
}

export const fontRegistry = {
  geist: { label: "Geist", font: staticFont("--font-geist", "geist") },
  inter: { label: "Inter", font: staticFont("--font-inter", "inter") },
  notoSans: { label: "Noto Sans", font: staticFont("--font-noto-sans", "noto-sans") },
  nunitoSans: { label: "Nunito Sans", font: staticFont("--font-nunito-sans", "nunito-sans") },
  figtree: { label: "Figtree", font: staticFont("--font-figtree", "figtree") },
  roboto: { label: "Roboto", font: staticFont("--font-roboto", "roboto") },
  raleway: { label: "Raleway", font: staticFont("--font-raleway", "raleway") },
  dmSans: { label: "DM Sans", font: staticFont("--font-dm-sans", "dm-sans") },
  publicSans: { label: "Public Sans", font: staticFont("--font-public-sans", "public-sans") },
  outfit: { label: "Outfit", font: staticFont("--font-outfit", "outfit") },
  geistMono: { label: "Geist Mono", font: staticFont("--font-geist-mono", "geist-mono") },
  geistPixelSquare: {
    label: "Geist Pixel Square",
    font: staticFont("--font-geist-pixel-square", "geist-pixel-square"),
  },
  jetBrainsMono: { label: "JetBrains Mono", font: staticFont("--font-jetbrains-mono", "jetbrains-mono") },
  notoSerif: { label: "Noto Serif", font: staticFont("--font-noto-serif", "noto-serif") },
  robotoSlab: { label: "Roboto Slab", font: staticFont("--font-roboto-slab", "roboto-slab") },
  merriweather: { label: "Merriweather", font: staticFont("--font-merriweather", "merriweather") },
  lora: { label: "Lora", font: staticFont("--font-lora", "lora") },
  playfairDisplay: { label: "Playfair Display", font: staticFont("--font-playfair-display", "playfair-display") },
} as const;

export type FontKey = keyof typeof fontRegistry;

export const fontVars = (Object.values(fontRegistry) as Array<(typeof fontRegistry)[FontKey]>)
  .map((f) => f.font.className)
  .join(" ");

export const fontOptions = (Object.entries(fontRegistry) as Array<[FontKey, (typeof fontRegistry)[FontKey]]>).map(
  ([key, f]) => ({
    key,
    label: f.label,
    variable: f.font.variable,
  }),
);
