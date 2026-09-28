"use client";

import { use } from "react";
import { toast } from "react-toastify";
import { submitIntakeForm } from "@/app/actions";
import Link from "next/link";

interface PageProps {
  params: Promise<{ slug: string }>;
}

type Language = "english" | "spanish" | "portuguese";

const translations: Record<Language, Record<string, string>> = {
  english: {
    title: "Patient Intake Form",
    subtitle: "Complete your details to initiate AI receptionist consultation",
    firstName: "First Name",
    lastName: "Last Name",
    email: "Email Address",
    dob: "Date of Birth",
    insurance: "Do you have insurance?",
    phone: "Doctor's Phone Number",
    appointmentDateTime: "Appointment Date & Time",
    whoToVisit: "Medical Department",
    additionalInfo: "Additional Information / Symptoms",
    submit: "Initiate Voice Consultation",
    yes: "Yes",
    no: "No",
    selectOption: "-- Select Department --",
    doctor: "General Practitioner",
    eyeDoctor: "Ophthalmology (Eye)",
    dentist: "Dental Care",
    pediatrician: "Pediatrics",
    psychiatrist: "Psychiatry & Mental Health",
    other: "Specialist Consultation",
    toastProcessing: "Processing intake & spinning up AI Agent...",
    back: "Back to Languages",
  },
  spanish: {
    title: "Formulario de Admisión",
    subtitle: "Complete sus datos para iniciar la consulta con el recepcionista de IA",
    firstName: "Nombre",
    lastName: "Apellido",
    email: "Correo Electrónico",
    dob: "Fecha de Nacimiento",
    insurance: "¿Tiene seguro médico?",
    phone: "Número de Teléfono del Doctor",
    appointmentDateTime: "Fecha y Hora de la Cita",
    whoToVisit: "Departamento Médico",
    additionalInfo: "Información Adicional / Síntomas",
    submit: "Iniciar Consulta por Voz",
    yes: "Sí",
    no: "No",
    selectOption: "-- Seleccionar Departamento --",
    doctor: "Médico General",
    eyeDoctor: "Oftalmología",
    dentist: "Odontología",
    pediatrician: "Pediatría",
    psychiatrist: "Psiquiatría y Salud Mental",
    other: "Consulta Especializada",
    toastProcessing: "Procesando admisión y conectando Agente IA...",
    back: "Volver a Idiomas",
  },
  portuguese: {
    title: "Formulário de Admissão",
    subtitle: "Preencha seus dados para iniciar a consulta com o recepcionista de IA",
    firstName: "Nome",
    lastName: "Sobrenome",
    email: "Endereço de E-mail",
    dob: "Data de Nascimento",
    insurance: "Você possui seguro médico?",
    phone: "Telefone do Médico",
    appointmentDateTime: "Data e Hora da Consulta",
    whoToVisit: "Departamento Médico",
    additionalInfo: "Informações Adicionais / Sintomas",
    submit: "Iniciar Consulta por Voz",
    yes: "Sim",
    no: "Não",
    selectOption: "-- Selecionar Departamento --",
    doctor: "Clínico Geral",
    eyeDoctor: "Oftalmologia",
    dentist: "Odontologia",
    pediatrician: "Pediatria",
    psychiatrist: "Psiquiatria e Saúde Mental",
    other: "Consulta Especializada",
    toastProcessing: "Processando admissão e iniciando Agente de Voz...",
    back: "Voltar para Idiomas",
  },
};

export default function LanguagePage({ params }: PageProps) {
  const { slug } = use(params);
  const lang = (slug as Language) || "english";
  const t = translations[lang] || translations.english;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    formData.append("language", lang);
    const result = await submitIntakeForm(formData);

    // The previous version showed a success toast unconditionally and then
    // redirected only if a spectateUrl happened to be present, so a rejected
    // submission looked identical to a booking until the page silently did
    // nothing.
    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    toast.success(t.toastProcessing);
    window.location.href = result.spectateUrl;
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xl my-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs text-cyan-600 hover:text-cyan-700 mb-6 font-semibold transition-colors"
        >
          &larr; {t.back}
        </Link>

        <div className="bg-white border border-slate-200 rounded-3xl p-8 shadow-xl">
          <div className="mb-8 text-center">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mb-2">
              {t.title}
            </h1>
            <p className="text-sm text-slate-500">{t.subtitle}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="firstName"
                  className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
                >
                  {t.firstName}
                </label>
                <input
                  type="text"
                  id="firstName"
                  name="firstName"
                  required
                  placeholder="John"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-600/20 transition-all"
                />
              </div>

              <div>
                <label
                  htmlFor="lastName"
                  className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
                >
                  {t.lastName}
                </label>
                <input
                  type="text"
                  id="lastName"
                  name="lastName"
                  required
                  placeholder="Doe"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-600/20 transition-all"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
              >
                {t.email}
              </label>
              <input
                type="email"
                id="email"
                name="email"
                required
                placeholder="john.doe@example.com"
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-600/20 transition-all"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="dob"
                  className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
                >
                  {t.dob}
                </label>
                <input
                  type="date"
                  id="dob"
                  name="dob"
                  required
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-600/20 transition-all"
                />
              </div>

              <div>
                <label
                  htmlFor="phone"
                  className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
                >
                  {t.phone}
                </label>
                <input
                  type="tel"
                  id="phone"
                  name="phone"
                  required
                  placeholder="+1 (555) 019-2834"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-600/20 transition-all"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
                {t.insurance}
              </label>
              <div className="flex gap-6 bg-slate-50 border border-slate-300 rounded-xl p-3.5">
                <label className="flex items-center cursor-pointer text-sm font-medium text-slate-800">
                  <input
                    type="radio"
                    name="insurance"
                    value="yes"
                    required
                    className="mr-2 accent-cyan-600 w-4 h-4"
                  />
                  {t.yes}
                </label>
                <label className="flex items-center cursor-pointer text-sm font-medium text-slate-800">
                  <input
                    type="radio"
                    name="insurance"
                    value="no"
                    className="mr-2 accent-cyan-600 w-4 h-4"
                  />
                  {t.no}
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="appointmentDateTime"
                  className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
                >
                  {t.appointmentDateTime}
                </label>
                <input
                  type="datetime-local"
                  id="appointmentDateTime"
                  name="appointmentDateTime"
                  required
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-600/20 transition-all"
                />
              </div>

              <div>
                <label
                  htmlFor="medical_department"
                  className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
                >
                  {t.whoToVisit}
                </label>
                <select
                  id="medical_department"
                  name="medical_department"
                  required
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-600/20 transition-all"
                >
                  <option value="">{t.selectOption}</option>
                  <option value="Doctor">{t.doctor}</option>
                  <option value="Eye Doctor">{t.eyeDoctor}</option>
                  <option value="Dentist">{t.dentist}</option>
                  <option value="Pediatrician">{t.pediatrician}</option>
                  <option value="Psychiatrist">{t.psychiatrist}</option>
                  <option value="Other">{t.other}</option>
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="additionalInfo"
                className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
              >
                {t.additionalInfo}
              </label>
              <textarea
                id="additionalInfo"
                name="additionalInfo"
                rows={3}
                placeholder="Briefly describe your symptoms or reason for visit..."
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-600/20 transition-all resize-none"
              />
            </div>

            <button
              type="submit"
              className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-4 rounded-xl shadow-md transition-all duration-200 cursor-pointer text-center text-sm tracking-wide"
            >
              {t.submit}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
