export function HostingerVariableList() {
  return (
    <aside className="mt-4 rounded-xl border border-amber-200 bg-white p-4">
      <p className="text-xs font-semibold text-amber-950">
        Variabili server richieste, come gruppo indivisibile:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs text-amber-950">
        <li>HOSTINGER_API_TOKEN</li>
        <li>HOSTINGER_ACCOUNT_USERNAME</li>
        <li>HOSTINGER_SITE_DOMAIN</li>
      </ul>
      <p className="mt-3 text-xs leading-5 text-amber-900">
        Configura i valori su Vercel; non inserirli in questa pagina.
      </p>
    </aside>
  );
}
