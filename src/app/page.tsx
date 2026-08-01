import Link from "next/link";

import type { Metadata } from "next";

import { AUTH_ROUTES } from "@/lib/auth/routes";

export const metadata: Metadata = {
  title: "𝒲𝒾𝓉𝒽 𝒴ℴ𝓊 — 人机协作小说创作平台",
  description:
    "不是 AI 替你写书。是你与 AI 一起，把脑子里的一本本书，变成真实存在的文字。从书名到世界观，从大纲到每一章正文——先确认，再动笔，字字都经你手。",
};

const features = [
  {
    title: "先搭骨架，再填血肉",
    desc: "AI 先与你敲定书名、章节数、大纲、人设、世界观——这些是小说的钢筋。确认之后，AI 才根据它们写细纲、写正文。不跳步，不乱写。",
  },
  {
    title: "章节级协作",
    desc: "每一章，AI 先出细纲。你点头，才动笔写正文。写完后末尾附上「需要改吗，请告诉我」。满意即存入文件树；不满意，AI 按你说的改。",
  },
  {
    title: "11 个创意工具",
    desc: "脑洞、书名、细纲、人设、世界观、金手指、开篇、封面——每个工具背后独立 prompt，按需在右侧面板调用，不污染对话上下文。",
  },
];

const steps = [
  { num: "01", title: "定基调", desc: "与 AI 对话，敲定书名、字数、题材、风格。三言两语，AI 帮你收敛想法" },
  { num: "02", title: "搭框架", desc: "AI 根据基调出大纲、人设、世界观。你可以逐条编辑、确认、存入文件树" },
  { num: "03", title: "写正文", desc: "逐章推进：细纲 → 认可 → 正文 → 修改 → 存入。每一步都经你手" },
];

const faqs = [
  { q: "AI 生成的内容归谁所有？", a: "全部归你。Your story, your words. 我们只提供工具，作品版权完全属于你。" },
  {
    q: "AI 写的文会不会有「AI 味」？",
    a: "不会。我们的理念是人机协作，AI 出初稿+细纲，每一章都经过你的确认和修改。最终的文风是你与 AI 共同的产物，不是套话。",
  },
  {
    q: "和 ChatGPT 写小说有什么区别？",
    a: "ChatGPT 是单次对话，你要自己管上下文、管结构。𝒲𝒾𝓉𝒽 𝒴ℴ𝓊 内置工作区+文件树+章节管理+15+工具——AI 始终知道你写到了哪、角色是谁、世界观什么规则。上下文不丢。",
  },
  { q: "支持哪些题材？", a: "玄幻、都市、科幻、言情、悬疑、历史、异世界……任何你能想到的。日式轻小说和网文都适配。" },
  { q: "能写多长？", a: "目前验证过百万字级别的连载。AI 会跟踪已写章节的上下文，保证前后逻辑一致。" },
];

const glassPrimaryCtaClassName =
  "cursor-pointer rounded-lg border border-[#7BE0A1]/55 bg-[#2D9F5A]/25 font-semibold text-sm text-white shadow-[0_8px_24px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-md transition-all hover:border-[#9BE8B6]/80 hover:bg-[#2D9F5A]/40 hover:shadow-[0_0_30px_rgba(45,159,90,0.32),inset_0_1px_0_rgba(255,255,255,0.28)]";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#090B0F] text-white">
      {/* Video BG */}
      <div className="fixed inset-0 z-0">
        <video autoPlay muted loop playsInline className="h-full w-full object-cover">
          <source src="/scene1.mp4" type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-gradient-to-b from-[#090B0F]/60 via-transparent to-[#090B0F]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.7)_100%)]" />
      </div>

      {/* Nav */}
      <nav className="relative z-50 flex h-16 items-center justify-between px-6 lg:px-12">
        <span
          className="font-bold text-lg"
          style={{ fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic", color: "#2D9F5A" }}
        >
          𝒲𝒾𝓉𝒽 𝒴ℴ𝓊
        </span>
        <div className="flex items-center gap-3">
          <Link
            href={AUTH_ROUTES.login}
            className="cursor-pointer rounded-lg border border-white/10 bg-white/5 px-4 py-2 font-medium text-sm transition-colors hover:bg-white/10"
          >
            登录
          </Link>
          <Link
            href={AUTH_ROUTES.register}
            className={`${glassPrimaryCtaClassName} px-4 py-2`}
          >
            免费试用
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 flex flex-col items-center justify-center px-6 pt-24 pb-32 text-center">
        <h1 className="mb-6 max-w-3xl font-extrabold text-4xl leading-tight tracking-tight sm:text-5xl lg:text-6xl">
          脑子里那本书
          <br />
          <span className="bg-gradient-to-r from-[#2D9F5A] via-[#5FCF8A] to-white bg-clip-text text-transparent">
            现在就写出来
          </span>
        </h1>
        <p className="mb-10 max-w-xl text-lg text-white/60 leading-relaxed">
          不是 AI 替你写书。是你与 AI 一起，从书名到世界观，从大纲到每一章正文——先确认，再动笔，字字都经你手。
        </p>
        <div className="flex gap-4">
          <Link
            href={AUTH_ROUTES.login}
            className={`${glassPrimaryCtaClassName} px-8 py-3.5`}
          >
            免费开始 →
          </Link>
          <a
            href="#features"
            className="cursor-pointer rounded-lg border border-white/12 bg-white/5 px-8 py-3.5 font-medium text-sm text-white transition-colors hover:bg-white/10"
          >
            查看功能
          </a>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative z-10 mx-auto max-w-5xl px-6 py-24">
        <p className="mb-3 text-center font-semibold text-[#2D9F5A] text-xs uppercase tracking-widest">Core Features</p>
        <h2 className="mb-4 text-center font-bold text-3xl">不是 AI 写书，是你与 AI 写书</h2>
        <p className="mx-auto mb-14 max-w-lg text-center text-white/50">
          每一个环节的决策权都在你手里。AI 负责想、负责写初稿、负责改。
        </p>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-white/8 bg-white/[0.04] p-7 transition-all hover:border-white/15 hover:bg-white/[0.08]"
            >
              <h3 className="mb-2 font-bold text-lg">{f.title}</h3>
              <p className="text-sm text-white/55 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Workflow */}
      <section className="relative z-10 mx-auto max-w-5xl px-6 py-24">
        <p className="mb-3 text-center font-semibold text-[#2D9F5A] text-xs uppercase tracking-widest">How It Works</p>
        <h2 className="mb-4 text-center font-bold text-3xl">三步动笔</h2>
        <p className="mx-auto mb-14 max-w-lg text-center text-white/50">从灵感到成书，每一步都清晰可控</p>
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.num} className="text-center">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border-2 border-[#2D9F5A]/30 bg-[#2D9F5A]/10 font-bold text-[#2D9F5A] text-lg">
                {s.num}
              </div>
              <h3 className="mb-2 font-bold text-lg">{s.title}</h3>
              <p className="text-sm text-white/50">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="relative z-10 mx-auto max-w-2xl px-6 py-24">
        <p className="mb-3 text-center font-semibold text-[#2D9F5A] text-xs uppercase tracking-widest">FAQ</p>
        <h2 className="mb-10 text-center font-bold text-3xl">常见问题</h2>
        <div>
          {faqs.map((f, i) => (
            <details key={i} className="group border-white/10 border-b py-5">
              <summary className="flex cursor-pointer list-none items-center gap-4 transition-colors hover:text-white/80">
                <span className="font-bold text-[#2D9F5A] text-xs">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex-1 font-semibold text-sm">{f.q}</span>
                <svg
                  className="h-4 w-4 text-white/30 transition-transform group-open:rotate-180"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <p className="mt-3 pl-10 text-sm text-white/50 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 py-24 text-center">
        <h2 className="mb-8 font-bold text-3xl">脑子里那本书，现在就写出来</h2>
        <Link
          href={AUTH_ROUTES.login}
          className={`inline-flex ${glassPrimaryCtaClassName} px-8 py-3.5`}
        >
          免费开始 →
        </Link>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-white/8 border-t px-6 py-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <span
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontStyle: "italic",
              color: "#2D9F5A",
              fontWeight: 600,
              fontSize: 18,
            }}
          >
            𝒲𝒾𝓉𝒽 𝒴ℴ𝓊
          </span>
          <div className="flex gap-6 text-white/35 text-xs">
            <span className="cursor-not-allowed text-white/35">隐私政策（建设中）</span>
            <span className="cursor-not-allowed text-white/35">服务条款（建设中）</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
