import React from "react";
import { ArrowLeft, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import posthog from "posthog-js";
import { SEO } from "../components/SEO";
import { SiteFooter } from "../components/SiteFooter";

const sections = [
  ["Service and eligibility", "BrickBuilder AI is operated by Jake Johnson. It provides tools to create, edit, preview, store, and export brick models. You must be at least 13 years old, or the higher minimum age required where you live. If you are below the age of legal majority, use the service with your parent or guardian’s permission. Connected applications may have their own age requirements."],
  ["Free access and usage allowances", "BrickBuilder AI model generation and editing are provided free of charge. Credits shown in your account are free usage allowances, not purchased currency. Each successful AI generation or edit uses one allowance; viewing account details, progress, and saved model files does not. Usage limits and availability may change to manage capacity and prevent abuse. No purchase is required to contribute to the open-source project. Any optional order of physical parts is separate and subject to the price and conditions displayed at checkout."],
  ["Accounts and connected applications", "Keep your account credentials private. You are responsible for activity you authorize through your account. Connecting an application such as ChatGPT or Claude lets that application use the BrickBuilder tools you approve, including account information, model status and files, generation, and editing. You can revoke the connection through your account’s authorization controls. The connected application’s own terms and privacy practices also apply."],
  ["Your content and generated models", "You retain the rights you already hold in content you submit. You give BrickBuilder and its service providers permission to process and store that content as needed to provide the features you request. Sharing a model to the community makes it publicly available through the community features. You may view, export, and use generated models, subject to any third-party rights. AI output may resemble other output or contain errors; no exclusive rights or clearance of third-party rights is guaranteed."],
  ["Acceptable use", "Use the service lawfully and submit only content you are entitled to use. Do not attempt to access another account’s private models, bypass authentication or usage limits, disrupt the service, or abuse connected tools. Access may be limited to protect users, accounts, and service availability."],
  ["Model limitations", "Automated geometry checks and previews do not guarantee physical buildability, part availability, structural stability, or suitability for a particular use. Inspect downloaded models, parts lists, and instructions before ordering parts or assembling a design. BrickBuilder AI is independent and is not affiliated with or sponsored by the LEGO Group."],
] as const;

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <SEO title="Terms of Service — BrickBuilder" description="Terms for using BrickBuilder AI’s free model-generation and editing tools." url="https://brickbuilder.ai/terms" />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
          <Link to="/" onClick={() => posthog.capture("terms_of_service_interaction", { action: "return_home" })} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-[#f44336]">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />Back to BrickBuilder
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="mb-10 max-w-3xl">
          <FileText className="mb-5 h-8 w-8 text-[#f44336]" aria-hidden="true" />
          <h1 className="text-4xl font-black tracking-tight sm:text-5xl">Terms of Service</h1>
          <p className="mt-5 text-lg leading-8 text-slate-600">These terms apply when you use BrickBuilder AI’s model tools.</p>
          <p className="mt-4 text-sm text-slate-500">Effective October 1, 2026 · Operator: Jake Johnson</p>
        </div>
        <div className="max-w-3xl space-y-8 rounded-2xl border border-slate-200 bg-white p-5 sm:p-8">
          {sections.map(([title, text]) => <section key={title} className="space-y-3 border-b border-slate-200 pb-8">
            <h2 className="text-xl font-bold sm:text-2xl">{title}</h2>
            <p className="text-[15px] leading-7 text-slate-600 sm:text-base">{text}</p>
          </section>)}
          <section className="space-y-3">
            <h2 className="text-xl font-bold sm:text-2xl">Privacy, support, and ending use</h2>
            <p className="text-[15px] leading-7 text-slate-600 sm:text-base">Our <Link to="/privacy" onClick={() => posthog.capture("terms_of_service_interaction", { action: "view_privacy" })} className="font-semibold text-[#c62828] underline">Privacy Policy</Link> explains information handling. You may stop using the service and disconnect applications at any time. For support or account-deletion requests, email <a href="mailto:support@brickbuilder.ai" onClick={() => posthog.capture("terms_of_service_interaction", { action: "email_support" })} className="font-semibold text-[#c62828] underline break-all">support@brickbuilder.ai</a>.</p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
