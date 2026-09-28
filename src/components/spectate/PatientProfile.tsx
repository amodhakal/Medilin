import type { SpectatePatient } from "@/app/spectate/[id]/SpectateClient";

/**
 * The four record fields the operator watches during the call.
 *
 * Not the whole record, and that is the point. The decrypted record also holds
 * date of birth, insurance, the department, and the patient's own description
 * of their symptoms, none of which anyone needs on screen to watch a booking
 * call go through. The relay gets all of it; this card does not.
 */
export function PatientProfile({ patient }: { patient: SpectatePatient }) {
  return (
    <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 mb-8 backdrop-blur-md shadow-lg">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs uppercase tracking-wider font-semibold text-cyan-400">
          Patient Consultation Profile
        </h2>
        <span className="text-xs text-slate-400 bg-slate-800 px-3 py-1 rounded-full">
          Dept: <strong className="text-slate-200">{patient.medical_department}</strong>
        </span>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <div className="min-w-0">
          <dt className="text-slate-500 block text-xs">Patient Name</dt>
          <dd className="font-medium text-slate-200 truncate">
            {patient.firstName} {patient.lastName}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-500 block text-xs">Email</dt>
          <dd className="font-medium text-slate-200 truncate">{patient.email}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-500 block text-xs">Phone</dt>
          <dd className="font-medium text-slate-200 truncate">{patient.phone}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-500 block text-xs">Language</dt>
          <dd className="font-medium text-cyan-300 uppercase truncate">{patient.language}</dd>
        </div>
      </dl>
    </section>
  );
}
