import { getGeneratedModelPath } from '../utils/generationRoutes';
import { Link } from "react-router-dom";
import { ChevronLeft, Trophy, Gift, Mail, Eye } from "lucide-react";
import { SEO } from "../components/SEO";
import { SiteFooter } from "../components/SiteFooter";

export default function CompetitionsPage() {
  return (
    <>
      <SEO
        title="Competition | BrickBuilder AI"
        description="Enter the BrickBuilder Competition for a chance to win a $60 custom LEGO model. Submit your build to the Community Page by Sunday night!"
        url="https://brickbuilder.ai/competitions"
      />
      <div className="min-h-screen flex flex-col bg-white text-slate-900">
        <div className="flex-1 w-full max-w-3xl mx-auto px-6 py-8">
          <Link to="/" className="inline-flex items-center gap-2 group mb-8">
            <ChevronLeft className="h-5 w-5 text-slate-500 group-hover:text-[#f44336] group-hover:-translate-x-0.5 transition-all" />
            <span className="text-xl font-extrabold tracking-tight">
              <span className="text-[#ff4b4b]">BRICK</span>
              <span className="text-slate-900">BUILDER</span>
            </span>
          </Link>

          <div className="flex items-center gap-3 mb-6">
            <Trophy className="h-8 w-8 text-[#f44336]" />
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
              Brickworld 2026 BrickBuilder Competition
            </h1>
          </div>

          {/* Giveaway */}
          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-6 mb-6">
            <div className="flex items-center gap-2 mb-1">
              <Gift className="h-6 w-6 text-amber-600" />
              <h2 className="text-xl font-extrabold text-amber-700">
                Congrats to our winners! 🎉
              </h2>
            </div>
            {/* <p className="text-2xl font-bold text-slate-900">
              Win a $60 Custom LEGO Model
            </p> */}
          </div>

          {/* Featured builds */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
            {[
              {
                name: "Taylor Swift Eras Tour Stage",
                src: "/assets/competition/examples/brickworld-winners/taylorswift.png",
                href: getGeneratedModelPath("2133a9b4-0880-48c6-9c4a-c30707128448", true),
              },
              {
                name: "Castle",
                src: "/assets/competition/examples/brickworld-winners/castle.png",
                href: getGeneratedModelPath("a5485156-a15c-4a3e-b6d9-27baf08e476c", true),
              },
              {
                name: "Avocado",
                src: "/assets/competition/examples/brickworld-winners/avocado.png",
                href: getGeneratedModelPath("08e8eb8b-1134-41a7-9c98-17b05e817972", true),
              },
            ].map((model) => (
              <div key={model.name} className="flex flex-col items-center text-center">
                <Link to={model.href} className="block">
                  <img
                    src={model.src}
                    alt={`LEGO ${model.name} build`}
                    className="h-32 sm:h-40 w-auto object-contain drop-shadow-md transition-transform hover:scale-105"
                  />
                </Link>
                <p className="mt-3 font-bold text-slate-900">{model.name}</p>
                <Link
                  to={model.href}
                  className="mt-2 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 h-9 text-xs text-slate-900 no-underline hover:bg-slate-50 cursor-pointer"
                >
                  <Eye className="w-4 h-4"/> View Model
                </Link>
              </div>
            ))}
          </div>

          {/* Rules */}
          <div className="rounded-2xl bg-slate-50 border border-slate-200 p-6">
            <h2 className="text-xl font-extrabold mb-4">Brickworld Chicago attendees were given these rules:</h2>
            <ul className="space-y-3 text-lg text-slate-700">
              <li className="flex gap-3">
                <span className="text-[#f44336] font-bold">•</span>
                <span>
                  Post to the{" "}
                  <Link
                    to="/community"
                    className="text-[#f44336] font-semibold hover:underline"
                  >
                    Community Page
                  </Link>{" "}
                  by Sunday night June 21 11:59 PM CST
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-[#f44336] font-bold">•</span>
                <span>
                  Must scale down to{" "}
                  <span className="bg-yellow-200 font-bold px-1 rounded">
                    &lt; 600 bricks
                  </span>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-[#f44336] font-bold">•</span>
                <span>Unlimited submissions allowed!</span>
              </li>
            </ul>
          </div>

          {/* Winners */}
          {/* <div className="rounded-2xl bg-amber-50 border border-amber-200 p-6 flex items-center gap-3">
            <Mail className="h-6 w-6 text-amber-600 shrink-0" />
            <p className="text-lg font-bold text-amber-700">
              Top 3 models will receive an email Monday
            </p>
          </div> */}
        </div>
        <SiteFooter />
      </div>
    </>
  );
}
