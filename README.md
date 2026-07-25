# Hostinger Single-Site Console

Dashboard privata multiutente per amministrare, in modo confinato, un solo sito Node.js su un piano Hostinger Business. Questa release contiene autenticazione, gestione utenti, modello dati, audit, client Hostinger server-only e policy capability default-deny. Le capability operative Hostinger, oltre alla verifica iniziale del sito, non sono ancora esposte.

## Stack e requisiti

- Next.js 16 App Router, React 19, TypeScript strict, Tailwind CSS 4
- Better Auth con adapter Drizzle e sessioni persistenti PostgreSQL
- Neon PostgreSQL tramite driver HTTP serverless
- Node.js 22 LTS, definito in `package.json` e `.nvmrc`
- npm 10 o successivo
- Vercel senza custom server, filesystem persistente o processi always-on

Installa la versione corretta di Node con il version manager preferito:

```bash
nvm install
nvm use
node --version
```

## Installazione locale

```bash
npm ci
npm run verify
```

Non sono necessari `--legacy-peer-deps`, `--force` o configurazioni npm locali. Il lockfile esclude il peer opzionale Lynx non utilizzato e mantiene le versioni web compatibili con React 19.

Build e controlli statici funzionano senza `.env.local`. In questo stato l’applicazione non è operativa: resta fail-closed, mostra **Configurazione server richiesta**, non apre connessioni Neon e risponde `503` dalle route di autenticazione.

Per usare realmente l’applicazione, copia e compila `.env.local`, quindi:

```bash
cp .env.example .env.local
npm run db:migrate
npm run user:bootstrap
npm run dev
```

Apri `http://localhost:3000`.

## Comandi

| Comando | Funzione |
| --- | --- |
| `npm run dev` | Avvia Next.js in sviluppo |
| `npm run build` | Crea la build Vercel; non esegue migration |
| `npm run lint` | Esegue ESLint |
| `npm run typecheck` | Verifica TypeScript strict senza emettere file |
| `npm test` | Esegue i test Vitest |
| `npm run verify` | Esegue typecheck, lint, test e build, fermandosi al primo errore |
| `npm run db:generate` | Confronta schema e snapshot e genera eventuali migration |
| `npm run db:migrate` | Applica le migration pendenti tramite il journal Drizzle |
| `npm run user:bootstrap` | Crea il primo OWNER |

Migration e bootstrap non sono inclusi in `build`, `verify` o nelle richieste HTTP.

## Variabili d’ambiente

La convenzione scelta dall’applicazione è `AUTH_SECRET` + `APP_URL`. Non impostare `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` o versioni `NEXT_PUBLIC_`: la configurazione Better Auth riceve sempre valori validati esplicitamente.

| Nome | Obbligatorietà | Ambiente | Sensibilità | Esempio non reale | Provenienza |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Obbligatoria a runtime; non richiesta dal build | Local, Preview, Production | Segreta | `postgresql://USER:PASSWORD@HOST/DB?sslmode=require` | Neon → Connection details |
| `DATABASE_MIGRATION_URL` | Opzionale; prima scelta del solo runner migration | Shell locale/CI amministrativa | Segreta | `postgresql://USER:PASSWORD@HOST/DB?sslmode=require` | Override amministrativo |
| `DATABASE_URL_UNPOOLED` | Opzionale; fallback migration preferito | Local/integrazione Vercel | Segreta | `postgresql://USER:PASSWORD@HOST/DB?sslmode=require` | Neon/Vercel |
| `POSTGRES_URL_NON_POOLING` | Opzionale; secondo fallback migration | Local/integrazione Vercel | Segreta | `postgresql://USER:PASSWORD@HOST/DB?sslmode=require` | Neon/Vercel |
| `AUTH_SECRET` | Obbligatoria a runtime; non richiesta dal build | Local, Preview, Production | Segreta | `generated-high-entropy-value-minimum-32-chars` | `openssl rand -base64 48` |
| `APP_URL` | URL canonico completo; calcolabile nelle Preview Vercel | Local, Production, dominio custom | Non segreta | `https://your-project.vercel.app` | URL canonico dell’app |
| `HOSTINGER_API_TOKEN` | Opzionale, ma in gruppo | Production; normalmente assente in Preview | Segreta | Vuoto nel repository | hPanel Hostinger |
| `HOSTINGER_ACCOUNT_USERNAME` | Opzionale, ma in gruppo | Production | Sensibile | `u123456789` | Account hosting |
| `HOSTINGER_SITE_DOMAIN` | Opzionale, ma in gruppo | Production | Non segreta | `example.com` | Sito configurato |
| `BOOTSTRAP_OWNER_EMAIL` | Solo bootstrap | Shell locale/CI amministrativa | Dato personale | `owner@example.com` | Amministratore |
| `BOOTSTRAP_OWNER_NAME` | Solo bootstrap | Shell locale/CI amministrativa | Dato personale | `Site Owner` | Amministratore |
| `BOOTSTRAP_OWNER_PASSWORD` | Solo bootstrap | Shell locale/CI amministrativa | Segreta | `generated-strong-password` | Password manager |
| `VERCEL` | Automatica | Vercel | Non segreta | `1` | Vercel System Environment Variables |
| `VERCEL_ENV` | Automatica | Vercel | Non segreta | `preview` | Vercel |
| `VERCEL_URL` | Automatica | Vercel | Non segreta | `project-abc.vercel.app` | Vercel |
| `VERCEL_BRANCH_URL` | Automatica; alias del branch Git | Vercel | Non segreta | `project-git-main-team.vercel.app` | Vercel |
| `VERCEL_PROJECT_PRODUCTION_URL` | Automatica | Vercel | Non segreta | `project.vercel.app` | Vercel |

Le tre variabili Hostinger devono essere tutte presenti oppure tutte assenti. Se il gruppo è assente, la dashboard mostra **Hostinger non configurato** e non effettua chiamate Hostinger.

`AUTH_SECRET` deve contenere almeno 32 caratteri ad alta entropia. Placeholder noti e valori con varietà insufficiente vengono rifiutati.

La validazione è lazy: importare i moduli o compilare l’applicazione non crea valori sostitutivi. Quando una richiesta necessita realmente di database o autenticazione, la configurazione viene validata e l’assenza di valori mantiene l’applicazione nello stato di setup richiesto.

### Modalità setup richiesto

Quando `DATABASE_URL`, `AUTH_SECRET` oppure la base URL autorizzata non sono validi:

- `/setup-required` rimane accessibile senza database;
- login, home e dashboard vengono indirizzati alla pagina di setup;
- `/api/auth/*` risponde `503` con un errore generico e senza stack trace;
- non vengono costruiti Better Auth, Drizzle o il client Neon;
- non vengono create sessioni, utenti o credenziali temporanee.

Il superamento del build indica soltanto che il pacchetto è distribuibile: l’applicazione diventa utilizzabile solo dopo la configurazione runtime e un nuovo deployment.

### Better Auth: Local, Preview e Production

- In sviluppo `http://localhost:3000` viene autorizzato soltanto quando è impostato esplicitamente come `APP_URL`.
- In Production `APP_URL` deve contenere l’URL canonico completo, con HTTPS.
- `APP_URL` autorizza un unico origin canonico esatto.
- Quando `VERCEL=1`, gli host esatti forniti da `VERCEL_URL` (deployment), `VERCEL_BRANCH_URL` (alias del branch Git) e `VERCEL_PROJECT_PRODUCTION_URL` (dominio Production del progetto) vengono aggiunti all’allowlist.
- Le tre variabili URL di sistema vengono normalmente fornite da Vercel e non vanno impostate manualmente.
- I valori Vercel sono accettati solo come hostname sintatticamente validi sotto il confine esatto `.vercel.app`, senza protocollo, porta, credenziali, path, query, fragment, wildcard o spazi.
- Host e origini vengono normalizzati in lowercase, privati dei punti finali, deduplicati e autorizzati in modo esatto; ogni origin Vercel fidata usa HTTPS.
- Non viene usata la wildcard `*.vercel.app`.
- Host e origin sconosciuti vengono rifiutati; non esiste un fallback.
- Un `APP_URL` di produzione deve usare HTTPS e non può essere localhost.
- Cookie sicuri sono obbligatori quando `NODE_ENV=production`.
- `Host` e `X-Forwarded-Host` non vengono accettati liberamente: Better Auth li usa solo dopo il confronto con `allowedHosts`.
- Dopo ogni modifica alle variabili Vercel è necessario creare un nuovo deployment: i deployment esistenti non vengono aggiornati retroattivamente.

Per le Preview Vercel è consigliato un branch Neon separato e un `AUTH_SECRET` Preview dedicato. Il gruppo Hostinger può e dovrebbe rimanere assente.

## Neon e migration

Il runtime usa `drizzle-orm/neon-http`, senza pool TCP persistente. La connessione viene costruita in modo lazy e riutilizzata nell’istanza serverless; nessuna query viene eseguita durante la build.

Le migration CLI usano invece `pg` (`node-postgres`) con
`drizzle-orm/node-postgres`. Questa separazione evita la selezione automatica
del driver WebSocket di Drizzle Kit quando il comando viene eseguito da Node.js
locale. Il runner usa TLS, una sola connessione e chiude sempre il pool.

Il runner sceglie la prima variabile non vuota in quest’ordine:

1. `DATABASE_MIGRATION_URL`;
2. `DATABASE_URL_UNPOOLED`;
3. `POSTGRES_URL_NON_POOLING`;
4. `DATABASE_URL`.

L’URL unpooled è preferito perché il runner è un processo amministrativo breve
che gestisce già un pool locale da una sola connessione. Non è necessario
aggiungere `DATABASE_MIGRATION_URL` a Vercel quando l’integrazione fornisce già
`DATABASE_URL_UNPOOLED` o `POSTGRES_URL_NON_POOLING`. Questa selezione è
indipendente da `DATABASE_URL`, che resta la configurazione del runtime Neon
HTTP.

Le migration correnti sono:

1. `0000_good_lady_bullseye.sql`: schema iniziale, vincoli, foreign key e indici.
2. `0001_public_sway.sql`: indici univoci case-insensitive per email e dominio.

Drizzle registra le migration applicate in
`drizzle.__drizzle_migrations`: rieseguire `npm run db:migrate` è idempotente e
applica solo quelle pendenti. Prima di applicarle, il runner verifica la
connessione con `SELECT 1`; dopo l’applicazione verifica che la tabella esista e
che il numero di righe corrisponda al journal versionato locale. Un successo
viene restituito soltanto dopo queste verifiche e la chiusura del pool.

Il CLI carica prima `.env.local` e poi `.env`, senza sovrascrivere variabili già
impostate nel processo e senza stampare valori o dettagli di connessione. Per
eseguire le migration e controllare il vero exit code in PowerShell:

```powershell
npm run db:migrate
$LASTEXITCODE
```

Il valore atteso è `0`; ogni errore di configurazione, connessione, migration,
verifica o chiusura restituisce `1` con diagnostica sanificata.

Per modifiche future allo schema, il flusso obbligatorio resta:

```bash
npm run db:generate
# controllare manualmente il nuovo SQL
npm run db:migrate
```

Non usare `drizzle-kit push` sul database Production. Le modifiche devono
passare da schema TypeScript, `drizzle-kit generate`, revisione SQL e runner
programmatico `npm run db:migrate`.

## Bootstrap del primo OWNER

Non esiste registrazione pubblica. Esempio con variabili d’ambiente:

```bash
BOOTSTRAP_OWNER_EMAIL=owner@example.com \
BOOTSTRAP_OWNER_NAME="Site Owner" \
BOOTSTRAP_OWNER_PASSWORD="A-strong-password-123!" \
npm run user:bootstrap
```

PowerShell:

```powershell
$env:BOOTSTRAP_OWNER_EMAIL="owner@example.com"
$env:BOOTSTRAP_OWNER_NAME="Site Owner"
$env:BOOTSTRAP_OWNER_PASSWORD="A-strong-password-123!"
npm run user:bootstrap
```

Dopo avere completato sia migration sia bootstrap, elimina la copia locale dei
secret. Il file è ignorato da Git, ma resta comunque materiale sensibile:

```powershell
Remove-Item -LiteralPath .env.local
```

Su macOS/Linux:

```bash
rm -- .env.local
```

Sono supportati anche `--email=`, `--name=` e `--password=`, ma la password sulla riga di comando può essere visibile nell’elenco processi: preferire variabili temporanee o un secret manager.

Lo script:

- funziona su Windows, macOS e Linux;
- rifiuta password deboli ed email duplicate;
- non stampa la password;
- termina con exit code non zero in caso di errore;
- elimina l’utente appena creato se la creazione delle credenziali fallisce;
- crea la membership iniziale se il gruppo Hostinger è configurato.

## Autenticazione e confine single-site

- Better Auth email/password con signup pubblico disabilitato.
- Password hash tramite scrypt.
- Sessioni persistenti senza cookie cache.
- Stato utente riletto dal database sulle pagine protette.
- Disabilitare un collaboratore revoca immediatamente tutte le sue sessioni.
- Password temporanea generata con `crypto.randomBytes` e restituita una sola volta.
- Cambio password obbligatorio e revoca delle altre sessioni.
- `OWNER` e `COLLABORATOR` avranno gli stessi permessi operativi sul sito; solo configurazione e gestione utenti restano OWNER-only.
- Sito, username, dominio ed external ID vengono risolti dal server.
- Capability non registrate vengono negate.
- Non esiste un proxy Hostinger generico.

## GitHub Actions

`.github/workflows/ci.yml` viene eseguito sui push e sulle pull request verso `main`. Usa Node dalla `.nvmrc`, cache npm e:

```text
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Il workflow non imposta variabili applicative o secret. Il build verifica quindi anche la modalità fail-closed iniziale; non contatta Neon, non applica migration e non chiama Hostinger.

## Primo deploy: Neon → GitHub → Vercel

### FASE A — Prima configurazione senza database

1. Installa e attiva Node.js 22.
2. Esegui `npm ci`.
3. Esegui `npm run verify` senza creare `.env.local`.
4. Controlla diff, migration e assenza di secret.
5. Crea il repository GitHub, effettua il primo commit e il primo push.
6. Importa il repository in Vercel senza modificare il Build Command.
7. Completa il primo deployment. Finché il runtime non è configurato, il sito mostra **Configurazione server richiesta**.

### FASE B — Dopo la creazione del progetto Vercel

1. Installa Neon dal Marketplace Vercel.
2. Collega Neon a Production e agli ambienti Preview desiderati.
3. Verifica in Vercel che `DATABASE_URL` sia presente negli ambienti corretti.
4. Genera e configura un `AUTH_SECRET` ad alta entropia.
5. Configura `APP_URL` Production con l’origin HTTPS canonico completo. Nelle Preview può essere derivato dagli hostname esatti forniti automaticamente da Vercel.
6. Scarica le variabili per lo sviluppo locale con il flusso Vercel oppure crea localmente `.env.local` senza tracciarlo.
7. Esegui `npm run db:migrate` contro il database scelto.
8. Imposta temporaneamente le variabili bootstrap ed esegui `npm run user:bootstrap`.
9. Avvia un nuovo deployment Vercel: le modifiche alle variabili non aggiornano deployment già completati.
10. Verifica login, cookie sicuri, logout e pagine protette.
11. Per un futuro dominio personalizzato, aggiorna `APP_URL` e avvia un ulteriore redeploy.

Non è necessario `vercel.json`.

## Checklist Prima del push

- [ ] `npm ci` completato senza flag speciali
- [ ] `npm run verify` superato
- [ ] `git status` mostra soltanto modifiche intenzionali
- [ ] esiste solo `.env.example`; nessun `.env*` reale è tracciato
- [ ] le migration e il journal Drizzle sono coerenti
- [ ] scansione secret completata
- [ ] diff completo revisionato
- [ ] nessun token Hostinger o URL Neon reale nei file o nella cronologia
- [ ] nessun commit, push o deploy automatico eseguito dagli script

## Limitazioni note

- Nessuna capability Hostinger aggiuntiva è implementata in questa fase.
- Email delivery e recupero password non sono configurati.
- La sincronizzazione Hostinger reale deve essere provata con un token di staging/non distruttivo.
- Preview e Production devono usare database e secret appropriati ai rispettivi ambienti.

## Prossima fase suggerita

Implementare prima le capability read-only per build Node.js e build log, con binding dei build UUID, `requireSiteAccess`, audit e test mock, prima di aggiungere qualsiasi controllo mutativo.
