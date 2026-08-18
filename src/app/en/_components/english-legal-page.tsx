import { ArrowLeft, ExternalLink, Mail } from "lucide-react";
import Link from "next/link";

export type EnglishLegalSection = {
  title: string;
  items: string[];
};

export type EnglishLegalAction = {
  href: string;
  label: string;
  type?: "email" | "external";
};

export function EnglishLegalPage({
  title,
  updatedAt,
  intro,
  sections,
  actions = [],
  chineseHref,
}: {
  title: string;
  updatedAt: string;
  intro: string;
  sections: EnglishLegalSection[];
  actions?: EnglishLegalAction[];
  chineseHref: string;
}) {
  return (
    <main className="min-h-screen bg-[#f7f8f6] text-[#13231d]" lang="en">
      <div className="mx-auto w-full max-w-[760px] px-5 py-6 sm:px-8 sm:py-10">
        <Link className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#176b59]" href="/app">
          <ArrowLeft className="h-4 w-4" />
          Back to OwnMinutes
        </Link>

        <article className="mt-6">
          <header className="border-b border-[#dce4df] pb-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[#176b59]">OwnMinutes</p>
              <Link className="text-sm font-semibold text-[#176b59]" href={chineseHref} hrefLang="zh-CN">
                中文
              </Link>
            </div>
            <h1 className="mt-3 text-3xl font-bold sm:text-4xl">{title}</h1>
            <p className="mt-3 text-sm text-[#68766f]">Last updated: {updatedAt}</p>
            <p className="mt-5 text-base leading-7 text-[#405048]">{intro}</p>
          </header>

          <div className="divide-y divide-[#dce4df]">
            {sections.map((section) => (
              <section className="py-7" key={section.title}>
                <h2 className="text-xl font-bold">{section.title}</h2>
                <ul className="mt-4 space-y-3">
                  {section.items.map((item) => (
                    <li className="flex gap-3 text-sm leading-6 text-[#405048] sm:text-base sm:leading-7" key={item}>
                      <span aria-hidden="true" className="mt-[0.65rem] h-1.5 w-1.5 shrink-0 rounded-full bg-[#2a8067]" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {actions.length > 0 ? (
            <div className="flex flex-col gap-3 border-t border-[#dce4df] py-7 sm:flex-row sm:flex-wrap">
              {actions.map((action) => {
                const Icon = action.type === "external" ? ExternalLink : Mail;
                return (
                  <a
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#176b59] px-4 py-3 text-sm font-semibold text-white hover:bg-[#125746]"
                    href={action.href}
                    key={`${action.href}-${action.label}`}
                    rel={action.type === "external" ? "noreferrer" : undefined}
                    target={action.type === "external" ? "_blank" : undefined}
                  >
                    <Icon className="h-4 w-4" />
                    {action.label}
                  </a>
                );
              })}
            </div>
          ) : null}

          <nav aria-label="Legal and support" className="flex flex-wrap gap-x-5 gap-y-3 border-t border-[#dce4df] py-6 text-sm font-semibold text-[#176b59]">
            <Link href="/en/support">Support</Link>
            <Link href="/en/privacy">Privacy Policy</Link>
            <Link href="/en/terms">Terms of Service</Link>
            <Link href="/en/data-deletion">Data Deletion</Link>
          </nav>
        </article>
      </div>
    </main>
  );
}
