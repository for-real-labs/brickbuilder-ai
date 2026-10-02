import React from "react";
import { ArrowLeft, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import posthog from "posthog-js";
import { Link } from "react-router-dom";

import { SEO } from "../components/SEO";
import { SiteFooter } from "../components/SiteFooter";

const LAST_UPDATED = "October 2, 2026";

const trackPrivacyInteraction = (action: string) => {
  posthog.capture("privacy_policy_interaction", { action });
};

function PolicySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-b border-slate-200 pb-8 last:border-b-0 last:pb-0">
      <h2 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
        {title}
      </h2>
      <div className="space-y-3 text-[15px] leading-7 text-slate-600 sm:text-base">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <SEO
        title="Privacy Policy — BrickBuilder"
        description="Learn how BrickBuilder collects, uses, protects, and shares information."
        url="https://brickbuilder.ai/privacy"
      />

      <header className="border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <Link
            to="/"
            onClick={() => trackPrivacyInteraction("return_home")}
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition-colors hover:text-[#f44336]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to BrickBuilder
          </Link>
          <span className="hidden text-sm font-black uppercase tracking-wide text-slate-900 sm:inline">
            <span className="text-[#f44336]">Brick</span>Builder
          </span>
        </div>
      </header>

      <main>
        <section className="bg-white">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="max-w-3xl">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-red-100 bg-red-50 px-3 py-1.5 text-sm font-semibold text-[#c62828]">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Your privacy matters
              </div>
              <h1 className="text-4xl font-black tracking-tight text-slate-950 sm:text-5xl">
                Privacy Policy
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
                This policy explains how BrickBuilder handles information when you use our
                website, mobile app, model-generation tools, community, and ordering features.
              </p>
              <p className="mt-4 text-sm font-medium text-slate-500">
                Last updated: {LAST_UPDATED}
              </p>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <LockKeyhole className="h-6 w-6 text-[#f44336]" aria-hidden="true" />
              <h2 className="mt-3 font-bold text-slate-900">No advertising sale</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                We do not sell your personal information or use it for third-party targeted
                advertising.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <Mail className="h-6 w-6 text-[#f44336]" aria-hidden="true" />
              <h2 className="mt-3 font-bold text-slate-900">Questions or deletion requests</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Email{" "}
                <a
                  href="mailto:support@brickbuilder.ai"
                  onClick={() => trackPrivacyInteraction("email_support_summary")}
                  className="font-semibold text-[#c62828] underline decoration-red-200 underline-offset-2"
                >
                  support@brickbuilder.ai
                </a>
                .
              </p>
            </div>
          </div>

          <article className="mt-6 space-y-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
            <PolicySection title="1. Information we collect">
              <p>Depending on how you use BrickBuilder, we may collect:</p>
              <ul className="list-disc space-y-2 pl-5 marker:text-[#f44336]">
                <li>
                  <strong className="text-slate-800">Account information</strong>, such as your
                  email address, authentication identifiers, username, credit balance, and account
                  settings.
                </li>
                <li>
                  <strong className="text-slate-800">Content you provide</strong>, including text
                  prompts, reference images, photos, GLB or LDraw files, model edits, generated
                  models, model names, and content you choose to publish to the community.
                </li>
                <li>
                  <strong className="text-slate-800">Order and transaction information</strong>,
                  such as selected parts, order totals, transaction identifiers, and contact or
                  fulfillment information. Payment-card details are handled by Stripe and are not
                  stored by BrickBuilder.
                </li>
                <li>
                  <strong className="text-slate-800">Usage and technical information</strong>,
                  including app interactions, feature usage, device and browser type, approximate
                  location derived from IP address, diagnostic data, and error information.
                </li>
                <li>
                  <strong className="text-slate-800">Local app data</strong>, such as session
                  tokens, recent generation identifiers, model state, and preferences stored on
                  your device to keep you signed in and preserve your work.
                </li>
              </ul>
            </PolicySection>

            <PolicySection title="2. Camera and photo library access">
              <p>
                The iOS app requests camera or photo-library access only when you choose to take or
                select a reference image. BrickBuilder does not access these resources in the
                background. You can change either permission at any time in iOS Settings.
              </p>
            </PolicySection>

            <PolicySection title="3. How we use information">
              <p>We use information to:</p>
              <ul className="list-disc space-y-2 pl-5 marker:text-[#f44336]">
                <li>create, edit, store, display, and export brick models and instructions;</li>
                <li>provide accounts, authentication, credits, community, and support;</li>
                <li>estimate part costs, process orders, and provide transaction communications;</li>
                <li>operate, secure, troubleshoot, analyze, and improve BrickBuilder; and</li>
                <li>comply with law, enforce our terms, and prevent abuse or fraud.</li>
              </ul>
            </PolicySection>

            <PolicySection title="4. When we share information">
              <p>
                We share information only as needed to operate BrickBuilder, at your direction, or
                when required by law. Service providers may include:
              </p>
              <ul className="list-disc space-y-2 pl-5 marker:text-[#f44336]">
                <li>
                  <strong className="text-slate-800">Supabase</strong> for authentication,
                  databases, and file storage;
                </li>
                <li>
                  <strong className="text-slate-800">OpenAI, Anthropic, fal.ai, and RunPod</strong> for AI
                  and model-processing features;
                </li>
                <li>
                  <strong className="text-slate-800">PostHog</strong> for product analytics and
                  error diagnostics;
                </li>
                <li>
                  <strong className="text-slate-800">Stripe</strong> for payment processing;
                </li>
                <li>
                  <strong className="text-slate-800">Railway and Vercel</strong> for application
                  hosting and delivery;
                </li>
                <li>
                  <strong className="text-slate-800">Resend</strong> for transactional email; and
                </li>
                <li>
                  <strong className="text-slate-800">BrickOwl or other fulfillment partners</strong>
                  when you choose ordering or parts-list features.
                </li>
              </ul>
              <p>
                We require service providers that receive personal information to use it only for
                the services they provide to us and to provide protections consistent with this
                policy and applicable law. We may also disclose information in a business transfer
                or to protect rights, safety, and service integrity.
              </p>
            </PolicySection>

            <PolicySection title="AI processing and your permission">
              <p>
                In the Expo mobile app, before a generation, AI edit, or model conversion request
                that uses AI processing, BrickBuilder asks for your permission. We send your text prompts and
                edit instructions, reference images or photos you select, and model data and previews
                needed for the request to OpenAI, Anthropic, fal.ai, and RunPod, depending on the feature and
                selected model. Model content may also be used to suggest a title. Any personal
                information included in your submitted content is included in that processing.
              </p>
              <p>
                These providers process the content to create or edit your model, generate previews,
                or suggest titles. We require third parties receiving personal information to provide
                the same or equal protection described in this policy. Do not submit confidential or
                sensitive personal information that you do not want these providers to process.
              </p>
              <p>
                In the Expo mobile app, permission is saved on this device. You can decline and continue browsing or ordering
                physical bricks, or withdraw permission using AI privacy in the app footer. Withdrawal
                stops future AI requests; it does not reverse processing already started. After
                withdrawal, we ask again before another AI request. For deletion requests, contact
                support@brickbuilder.ai.
              </p>
            </PolicySection>

            <PolicySection title="5. Community content">
              <p>
                A model, preview image, model name, username, and creation date become publicly
                visible only when you choose to post the model to the BrickBuilder community.
                Please do not publish content containing personal or confidential information. You
                can remove a model from the community using the model page.
              </p>
            </PolicySection>

            <PolicySection title="6. Retention and deletion">
              <p>
                We retain account information and saved generations while your account is active or
                as needed to provide the service. Anonymous generations, diagnostics, and service
                logs are retained only as long as reasonably necessary for product operation,
                security, support, and legal obligations. Transaction records may be retained as
                required for accounting, tax, fraud prevention, and dispute resolution.
              </p>
              <p>
                You may request deletion of your account and associated personal information by
                emailing{" "}
                <a
                  href="mailto:support@brickbuilder.ai?subject=Privacy%20deletion%20request"
                  onClick={() => trackPrivacyInteraction("email_deletion_request")}
                  className="font-semibold text-[#c62828] underline decoration-red-200 underline-offset-2"
                >
                  support@brickbuilder.ai
                </a>
                . We may retain limited information where required by law or necessary to protect
                the service and its users.
              </p>
            </PolicySection>

            <PolicySection title="7. Your choices and rights">
              <p>
                You can choose whether to create an account, whether to grant camera or photo access,
                and whether to publish a model publicly. Depending on where you live, you may also
                have rights to access, correct, delete, or receive a copy of your personal
                information, or to object to or restrict certain processing. Contact us to exercise
                these rights. We may need to verify your identity before completing a request.
              </p>
            </PolicySection>

            <PolicySection title="8. Security and international processing">
              <p>
                We use reasonable administrative, technical, and organizational safeguards designed
                to protect information. No internet service can guarantee absolute security. Our
                providers may process information in the United States and other countries, where
                privacy laws may differ from those where you live.
              </p>
            </PolicySection>

            <PolicySection title="9. Children">
              <p>
                BrickBuilder is not directed to children under 13, and we do not knowingly collect
                personal information from children under 13. If you believe a child has provided
                personal information, contact us so we can investigate and delete it where required.
              </p>
            </PolicySection>

            <PolicySection title="10. Changes and contact">
              <p>
                We may update this policy as BrickBuilder changes. We will post the revised policy
                here and update the date above. For privacy questions, requests, or complaints,
                contact{" "}
                <a
                  href="mailto:support@brickbuilder.ai"
                  onClick={() => trackPrivacyInteraction("email_support_contact")}
                  className="font-semibold text-[#c62828] underline decoration-red-200 underline-offset-2"
                >
                  support@brickbuilder.ai
                </a>
                .
              </p>
            </PolicySection>
          </article>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
