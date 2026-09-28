import Link from "next/link";

const languages = [
  { slug: "english", name: "English", flag: "🇺🇸", description: "Seamless voice intake in English" },
  { slug: "spanish", name: "Español", flag: "🇪🇸", description: "Admisión médica guiada por voz en español" },
  { slug: "portuguese", name: "Português", flag: "🇧🇷", description: "Triagem de pacientes por voz em português" },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-between p-6 sm:p-10">
      {/* Header */}
      <header className="w-full max-w-6xl mx-auto flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-600 flex items-center justify-center font-bold text-xl text-white shadow-sm">
            M
          </div>
          <span className="text-xl font-bold tracking-tight text-slate-900">
            Medilin
          </span>
        </div>
        <div className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 px-3.5 py-1.5 rounded-full">
          Prototype &mdash; not for clinical use
        </div>
      </header>

      {/* Main Hero Content */}
      <main className="w-full max-w-4xl mx-auto text-center my-auto py-12">
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight mb-6 text-slate-900 leading-tight">
          Intelligent Medical <br />
          <span className="text-cyan-600">Voice Assistant</span>
        </h1>

        <p className="text-slate-600 text-lg sm:text-xl max-w-2xl mx-auto mb-12 font-normal leading-relaxed">
          Streamline patient intake with autonomous AI voice agents. Select your preferred language to begin.
        </p>

        {/* Language Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl mx-auto text-left">
          {languages.map((lang) => (
            <Link
              key={lang.slug}
              href={`/language/${lang.slug}`}
              className="group bg-white border border-slate-200 hover:border-cyan-500 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between"
            >
              <div>
                <div className="text-3xl mb-4">{lang.flag}</div>
                <h2 className="text-lg font-bold text-slate-900 group-hover:text-cyan-600 transition-colors">
                  {lang.name}
                </h2>
                <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                  {lang.description}
                </p>
              </div>

              <div className="mt-8 flex items-center text-xs font-semibold text-cyan-600 group-hover:translate-x-1 transition-transform">
                Start Intake &rarr;
              </div>
            </Link>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full max-w-6xl mx-auto py-6 text-center text-xs text-slate-500 border-t border-slate-200">
        &copy; {new Date().getFullYear()} Medilin Systems. Powered by ElevenLabs Conversational AI & Gemini.
      </footer>
    </div>
  );
}
