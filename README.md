# Hostinger Single-Site Console

Dashboard privata multiutente per amministrare, in modo confinato, un solo sito Node.js su un piano Hostinger Business. Questa release contiene autenticazione, gestione utenti, modello dati, audit, client Hostinger server-only, onboarding con verifica/importazione del sito configurato, build e log read-only, riavvio controllato del server Node.js e gestione dei database assegnati al dominio con policy capability default-deny.

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

Le tre variabili Hostinger devono essere tutte presenti oppure tutte assenti:

- `HOSTINGER_API_TOKEN` è un secret esclusivamente server-side: non usare mai il
  prefisso `NEXT_PUBLIC_`, non inserirlo in props, form o repository;
- `HOSTINGER_ACCOUNT_USERNAME` identifica l’account hosting da confrontare in
  modo esatto;
- `HOSTINGER_SITE_DOMAIN` deve essere un hostname, non un URL. Protocollo,
  credenziali, porta, path, query, fragment, wildcard e caratteri di controllo
  vengono rifiutati. Gli IDN sono convertiti nella forma ASCII canonica e il
  confronto resta esatto, senza trasformare sottodomini.

Se il gruppo è assente, l’onboarding mostra **Hostinger non configurato** e non
effettua chiamate. Se è parziale mostra **Configurazione incompleta** e non
effettua chiamate. Quando è completo, il browser riceve soltanto il dominio
normalizzato; token e username non vengono serializzati.

Dopo qualsiasi modifica al gruppo in Vercel è necessario creare un nuovo
deployment. Per una futura rotazione del token:

1. crea un nuovo token in hPanel con i soli permessi necessari;
2. sostituisci `HOSTINGER_API_TOKEN` nei soli ambienti Vercel interessati;
3. crea un nuovo deployment e valida il token con una verifica server-side
   non distruttiva in un ambiente controllato;
4. revoca il token precedente in hPanel solo dopo il controllo, mantenendo
   disponibile il rollback alla variabile precedente fino a quel momento;
5. non copiare mai il token nei log, ticket, commit o variabili `NEXT_PUBLIC_`.

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

Il driver HTTP non supporta transazioni callback interattive. Per questo
l’importazione iniziale viene espressa come una sola istruzione PostgreSQL con
CTE: PostgreSQL la esegue atomicamente, mentre
`pg_advisory_xact_lock` serializza gli import single-site concorrenti. Site,
membership, binding e audit vengono quindi confermati insieme oppure
interamente annullati.

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
3. `0002_last_oracle.sql`: enum stato build e binding `site_builds` con UUID
   Hostinger globale univoco, foreign key al sito e indici di lettura.
4. `0003_hostinger_operations.sql`: registro durevole e riutilizzabile delle
   mutazioni Hostinger, stato operazione, chiave idempotente hashata, reference
   ID, correlation ID sanificato e vincolo di una sola operazione attiva per
   sito e tipo.
5. `0004_site_databases.sql`: binding non sensibili `site_databases`, vincoli
   di ownership globale del nome database, metriche Hostinger verificate e
   scope hashato per serializzare operazioni incompatibili sulla stessa
   risorsa senza persisterne il nome nel registro operazioni.

Drizzle registra le migration applicate in
`drizzle.__drizzle_migrations`: rieseguire `npm run db:migrate` è idempotente e
applica solo quelle pendenti. Prima di applicarle, il runner verifica la
connessione con `SELECT 1`; dopo l’applicazione verifica che la tabella esista e
che il numero di righe corrisponda al journal versionato locale. Un successo
viene restituito soltanto dopo queste verifiche e la chiusura del pool.

Il CLI carica prima `.env.local` e poi `.env`, senza sovrascrivere variabili già
impostate nel processo e senza stampare valori o dettagli di connessione. Per
verificare lo stato senza modificare il database:

```powershell
npm run db:migrate:check
$LASTEXITCODE
```

Il check usa lo stesso parsing sicuro delle variabili del runner, verifica la
connessione, confronta il numero di righe in
`drizzle.__drizzle_migrations` con il journal locale e controlla
`public.site_builds`, `public.build_state`, `public.hostinger_operations`,
`public.hostinger_operation_status`, `public.site_databases`, la colonna
`hostinger_operations.resource_key_hash` e i relativi indici di scope
esclusivamente tramite query `SELECT`.
Stampa soltanto stato della connessione, conteggi, presenza di migration
pendenti e presenza degli oggetti richiesti. Restituisce `0` soltanto quando lo
schema locale atteso è completamente disponibile.

Per applicare le migration e controllare il vero exit code in PowerShell:

```powershell
npm run db:migrate
$LASTEXITCODE
```

Il valore atteso è `0`; ogni errore di configurazione, connessione, migration,
verifica o chiusura restituisce `1` con diagnostica sanificata.

### Runbook migration Production su Vercel

Le variabili configurate nel progetto Vercel non sono automaticamente
disponibili nella shell locale. Il metodo preferito evita di salvarle su disco:

```powershell
vercel link
vercel env ls production
vercel env run -e production -- npm run db:migrate:check
vercel env run -e production -- npm run db:migrate
vercel env run -e production -- npm run db:migrate:check
```

Prima di procedere, verificare che la directory locale sia collegata al
progetto Vercel corretto. Per `DATABASE_MIGRATION_URL` o
`DATABASE_URL_UNPOOLED` usare una connection string Neon diretta/non pooled;
non copiare connection string, credenziali o altri secret nei log, nella
documentazione o nei comandi salvati.

Il runner è idempotente: applica soltanto le migration pendenti registrandole
in `drizzle.__drizzle_migrations`. Non usare `drizzle-kit push`. Eseguire il
check finale e confermare che migration e oggetti richiesti siano presenti
prima di aggiornare `/builds`.

Le migration non devono essere aggiunte al Build Command Vercel, eseguite
durante il build o lo startup, né avviate da richieste HTTP. Restano
un’operazione amministrativa esplicita e separata.

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
- non richiede variabili Hostinger;
- non crea siti o membership provvisorie.

Il primo OWNER senza membership viene indirizzato a `/onboarding`. Il sito e la
membership amministrativa vengono creati soltanto dopo discovery esatto,
capability probe Node.js e conferma esplicita.

## Onboarding Hostinger e importazione

Il flusso `/onboarding` è disponibile soltanto a un OWNER attivo nello stato
`owner_onboarding_required`:

1. la pagina mostra lo stato pubblico del gruppo Hostinger e, quando completo,
   il solo dominio canonico;
2. **Verifica sito Hostinger** chiama
   `GET /api/hosting/v1/websites` con dominio e username provenienti dalla
   configurazione server;
3. la risposta viene validata e post-filtrata localmente per dominio
   normalizzato e username esatti;
4. zero corrispondenze restituiscono “sito configurato non trovato”; più
   corrispondenze falliscono in modo chiuso come ambigue;
5. una sola corrispondenza viene verificata come Node.js tramite
   `GET /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/builds`;
   anche un elenco build vuoto conferma la capability;
6. il browser vede soltanto dominio, stato, flag Node.js e l’eventuale order ID
   della corrispondenza selezionata;
7. l’OWNER digita il dominio configurato come conferma. Questo input non viene
   mai usato per costruire la richiesta Hostinger;
8. discovery e probe vengono ripetuti server-side subito prima del salvataggio;
9. sito `VERIFIED`, membership `ADMIN`, binding del dominio principale e audit
   vengono scritti in un’unica istruzione PostgreSQL atomica;
10. dopo il successo l’accesso viene ricalcolato e l’OWNER viene reindirizzato
    una sola volta a `/overview`.

Le Server Actions ricontrollano sessione, utente attivo, ruolo, stato
onboarding, configurazione e conferma. Next.js applica la protezione same-origin
alle Server Actions; doppio click e submit concorrenti sono inoltre contenuti
dalla UI, da un advisory lock transazionale PostgreSQL e dai vincoli univoci.
Non viene usato un rate limiter o un flag globale in memoria.

L’importazione è idempotente per stesso OWNER e stesso sito. Un sito differente,
uno username incompatibile o una membership verso un altro sito producono un
conflitto e non sostituiscono né eliminano record esistenti. La risposta grezza,
gli altri siti del piano, altri username e order ID non selezionati non
raggiungono mai il client, il database o l’audit.

## Autenticazione e confine single-site

- Better Auth email/password con signup pubblico disabilitato.
- Password hash tramite scrypt.
- Sessioni persistenti senza cookie cache.
- Stato utente riletto dal database sulle pagine protette.
- Disabilitare un collaboratore revoca immediatamente tutte le sue sessioni.
- Password temporanea generata con `crypto.randomBytes` e restituita una sola volta.
- Cambio password obbligatorio e revoca delle altre sessioni.
- OWNER attivo senza membership indirizzato all’onboarding, senza accesso alle
  pagine dashboard.
- COLLABORATOR senza membership negato secondo la policy not-found esistente.
- Una sola membership verso un sito `VERIFIED` abilita la dashboard; membership
  multiple, orfane o verso siti non utilizzabili falliscono in modo chiuso.
- Ogni utente attivo, non bannato, con sessione e membership valide sul sito
  configurato può usare tutte le capability Hostinger registrate, implementate
  e site-scoped.
- Le membership `ADMIN` e `MEMBER` hanno la stessa policy Hostinger fissa:
  non esistono grant per utente, ruoli Hostinger personalizzabili o pannelli di
  capability per collaboratore.
- `OWNER` e `COLLABORATOR` hanno quindi gli stessi permessi operativi
  Hostinger sul sito; onboarding, configurazione locale e gestione account
  dashboard restano OWNER-only.
- Sito, username, dominio ed external ID vengono risolti dal server.
- Capability non registrate vengono negate.
- Non esiste un proxy Hostinger generico.
- L’Overview mostra esclusivamente identità e verifica del sito Hostinger,
  Node.js, build, disponibilità restart, database assegnati, spazio e data
  dell’ultima sincronizzazione. Neon, PostgreSQL, autenticazione, sessioni,
  Vercel, URL della dashboard e contatori del registro capability non vengono
  presentati come risorse del sito.
- Build e log restano in sola lettura. Restart Node.js, operazioni database,
  cache site-scoped e patch selettiva delle vulnerabilità tramite pull request
  sono le mutazioni Hostinger implementate. Deploy da archivio, DNS e le altre
  capability fuori scope restano non implementati o negati.

## Build Node.js, log e restart controllato

La pagina `/builds` usa soltanto gli endpoint applicativi specifici
`GET /api/builds` e `GET /api/builds/{uuid}/logs`. Ogni richiesta ricalcola
sessione, stato utente e singola membership; username e dominio sono letti dal
record autorevole `sites` e non sono parametri accettati dal browser.

L’elenco Hostinger è validato con Zod, normalizzato in un payload minimo e
sincronizzato tramite upsert in `site_builds`. `build_uuid` è univoco
globalmente: un conflitto già associato a un altro sito non viene riassegnato.
La lettura log richiede prima un lookup composto `site_id + build_uuid`, quindi
un UUID valido ma estraneo restituisce not-found senza chiamare Hostinger.

La paginazione accetta `page` tra 1 e 10.000 e `per_page` tra 1 e 100; la UI usa
25 elementi. I log accettano soltanto `from_line` tra 0 e 10.000.000. Le build
`pending` o `running` aggiornano lo stato prima della lettura e la UI effettua
una sola richiesta concorrente ogni otto secondi; polling e fetch vengono
annullati quando il componente viene smontato e il polling termina allo stato
`completed` o `failed`.

Prima di raggiungere il browser, i log perdono le sequenze ANSI e vengono
redatti per bearer token, password, secret assegnati e connection string. Ogni
risposta è limitata a 128 KiB e ogni sessione di visualizzazione a 512 KiB. Il
contenuto non viene persistito, scritto nei log applicativi o incluso negli
audit: gli eventi contengono solo contatori, stato, identificatore hash e
correlation ID sanificato.

Il pannello operazioni di `/builds` espone il solo
`POST /api/node/restart`. La richiesta accetta esclusivamente un body JSON
vuoto e l’header `Idempotency-Key` in formato UUID: username, dominio, site ID,
URL, metodo, order ID e token non sono parametri validi. Origin e
`Sec-Fetch-Site` vengono verificati prima dell’autorizzazione; sessione, stato
utente, membership, sito autorevole e capability `node.restart` vengono
ricalcolati server-side.

Il client server-only costruisce internamente
`POST /api/hosting/v1/accounts/{username}/websites/{domain}/nodejs/server/restart`
usando il record `sites`. La risposta Hostinger ufficiale vuota o con
`message` stringa viene validata ma scartata; soltanto esito minimo e
correlation ID sanificato restano nel backend.

Prima della chiamata esterna, `hostinger_operations` registra la chiave UUID
come hash SHA-256. Una singola istruzione PostgreSQL usa
`pg_advisory_xact_lock` sul sito e tipo operazione, il vincolo univoco impedisce
due operazioni `IN_PROGRESS` e un cooldown di 30 secondi blocca restart
ravvicinati. La stessa chiave non chiama mai Hostinger due volte; operazioni
rimaste attive oltre 120 secondi vengono chiuse come fallite prima di una nuova
richiesta. Nessuna `Map` runtime partecipa alla garanzia.

La UI applica anche un lock sincrono al submit, mostra una conferma esplicita,
pending, successo o errore con reference ID e mantiene il pulsante disabilitato
durante il cooldown. Dopo il successo aggiorna Overview e build una sola volta,
senza navigazioni o polling aggiuntivi.

## Database Hostinger confinati al dominio

La pagina `/databases` e gli endpoint applicativi `/api/databases/*`
implementano la superficie documentata
nell’[OpenAPI Hostinger ufficiale v1.23.0](https://github.com/hostinger/api/blob/main/openapi.json):

- lista e creazione database account;
- cambio password, repair asincrona ed eliminazione;
- lista, aggiunta e rimozione delle connessioni remote;
- generazione on-demand del link phpMyAdmin.

Non esiste un proxy Hostinger generico. Ogni route ricalcola sessione, stato
utente, membership e capability; le mutazioni verificano origin,
`Sec-Fetch-Site`, body Zod stretto e `Idempotency-Key` UUID. ADMIN e MEMBER
vedono la stessa pagina e possono eseguire le stesse operazioni site-scoped.

Gli endpoint Hostinger database sono account-scoped, quindi il server applica
un secondo confine:

1. il primo tentativo di lettura invia sempre il dominio normalizzato del
   record `sites` come filtro `domain` insieme a `is_assigned=true`;
2. soltanto se Hostinger rifiuta esattamente quel GET con `422`, il client
   read-only ripete una sola volta la stessa pagina senza i due filtri;
3. ogni record, incluso ogni risultato del fallback account-wide, viene
   validato e post-filtrato nuovamente per uguaglianza esatta
   del dominio normalizzato;
4. record senza dominio, di altri domini, malformati o duplicati vengono
   scartati e segnalati soltanto tramite contatori;
5. tutte le pagine Hostinger vengono filtrate prima di calcolare totale e
   paginazione applicativa, quindi nessun conteggio account-wide grezzo arriva
   al browser; oltre il limite sicuro di 100 pagine la lettura fallisce chiusa
   senza restituire risultati parziali;
6. il browser riceve un UUID locale opaco; nome completo e username Hostinger
   vengono risolti dal binding server-side;
7. prima di ogni mutazione e prima di generare phpMyAdmin, il database viene
   cercato nuovamente live con nome esatto, dominio e `is_assigned=true`; solo
   sullo stesso `422` già gestito dalla lista viene effettuato un singolo GET
   read-only senza `domain`/`is_assigned`, mantenendo `search`;
8. la verifica autorizza l’operazione soltanto se nome database, utente
   database e dominio normalizzato coincidono esattamente con binding locale e
   sito autorevole. Il fallback non viene mai applicato alla mutazione.

La lista delle connessioni remote applica la stessa singola compatibilità su
`422`: prima prova con `domain`, poi eventualmente una sola volta senza filtro.
Anche in questo caso il payload resta server-side e ogni regola deve
corrispondere per `database_name + database_user` a un database già
live-verificato per il sito. Le regole estranee, duplicate, wildcard o non
supportate vengono scartate.

I retry e i fallimenti delle letture producono
`hostinger_database_request_diagnostic` con reference ID, fase statica,
status, correlation ID sanificato e risultato. Payload, messaggi Hostinger,
username, dominio, database, utenti, IP, URL, query, token e stack non vengono
registrati. Se il fallback fallisce, lo stesso reference ID viene restituito
alla UI. Status diversi da `422`, timeout, `5xx` e fallimenti di decoding non
attivano fallback.

La creazione accetta dal browser soltanto suffisso nome, suffisso utente,
password e conferma. Il server costruisce i nomi completi con lo username
autorevole e imposta sempre `website_domain` al dominio configurato. Dopo la
risposta positiva esegue tre letture brevi e limitate per la consistenza
eventuale: se il record non è ancora visibile, la UI dichiara soltanto
“creation accepted”, senza fingere una sincronizzazione completata. Password,
payload Hostinger, host, connection string, link phpMyAdmin e regole remote non
vengono persistiti. La tabella `site_databases` contiene soltanto UUID locale,
site ID, nome e utente database, dominio verificato, spazio, timestamp
Hostinger, hash canonico del nome per il vincolo cross-site e timestamp di
verifica.

Il link phpMyAdmin viene richiesto solo al click. Il decoder usa come forma
primaria la risorsa OpenAPI diretta `{ "link": "..." }` e ammette come sola
compatibilità l'envelope `{ "data": { "link": "..." } }`, già usato da altri
endpoint Hostinger. Non effettua ricerche ricorsive: link assenti, non stringa,
troppo lunghi o diversi nelle due forme vengono rifiutati.

La URL temporanea è accettata soltanto con HTTPS, senza credenziali nella
authority (`username:password@host`), fragment, caratteri di controllo o porta
diversa da 443 e con hostname sotto il confine DNS esatto `.hostinger.com`; il
dominio radice e suffissi ingannevoli come `hostinger.com.evil.example` sono
negati. La query string firmata da Hostinger è trattata come opaca, resta
inalterata e non viene interpretata in base ai nomi dei parametri. La risposta
applicativa usa
`Cache-Control: private, no-store`, `Pragma: no-cache`,
`Referrer-Policy: no-referrer` e `X-Content-Type-Options: nosniff`. Dopo la
generazione la UI mostra un'azione utente esplicita **Open phpMyAdmin** con
`target="_blank"` e `rel="noopener noreferrer"`: non crea preventivamente una
scheda `about:blank`. Il link resta soltanto nello stato React transiente,
scade dopo 60 secondi e viene rimosso al click; non viene inserito in database,
storage browser, URL della dashboard, log o audit.

La diagnostica finale `database_phpmyadmin`, emessa una sola volta per
richiesta, distingue con categorie statiche la
verifica live, gli errori HTTP upstream, la forma risposta, link mancante o
ambiguo e i singoli confini URL; può indicare soltanto forme e caratteristiche
strutturali allowlistate, mai chiavi o valori del payload. Lo stesso reference
ID è restituito con un `diagnosticCode` statico allowlistato e mostrato dalla
UI. Non registra link, hostname, path, query, payload, database, utenti o
dominio. Le regole remote vengono incrociate con l'elenco live dei
database autorizzati; sono ammesse nelle mutazioni soltanto IPv4 o IPv6
specifiche. `%`, wildcard, hostname e CIDR vengono rifiutati.

Create, password, repair, delete e remote add/remove usano
`hostinger_operations`. La chiave idempotente è hashata; un secondo hash opaco
della risorsa alimenta advisory lock e indice univoco parziale, impedendo
operazioni incompatibili concorrenti sullo stesso database anche quando il tipo
operazione è diverso. Repair restituisce sempre “queued/accepted”: non dichiara
completato il lavoro asincrono Hostinger. Delete richiede conferma esplicita,
digitazione esatta del nome e rimuove il binding soltanto dopo la conferma
Hostinger o una post-condizione read-only autorevole che dimostri l’assenza
dopo un timeout/404 ambiguo. La rimozione remote richiede inoltre che la regola
IP sia ancora presente nella lista live autorizzata.

## Cache Hostinger site-scoped

La pagina `/site-tools` espone tre sole funzioni documentate in OpenAPI 1.23.0:

- `DELETE .../cache/clear`, senza directory controllabile dal browser;
- `PATCH .../cache/toggle` con il solo body `{ "enabled": boolean }`;
- `PATCH .../cacheless-mode/toggle` con lo stesso body stretto.

Username e dominio provengono sempre dal record `sites`. Ogni route verifica
Origin/CSRF, sessione, utente attivo, membership e capability, quindi richiede
conferma e `Idempotency-Key` UUID. Tutte le operazioni cache condividono lo
stesso hash risorsa in `hostinger_operations`: advisory lock e indice parziale
le serializzano anche quando hanno operation type differenti. Un cooldown
durevole di 15 secondi impedisce richieste ravvicinate; il lock UI è soltanto
una protezione aggiuntiva.

L’API pubblica non espone qui un GET autorevole dello stato cache. La UI usa
quindi azioni esplicite Enable/Disable, non switch, e mostra esclusivamente
l’ultima richiesta registrata dalla dashboard con questa etichetta. Non viene
presentata come stato corrente Hostinger. Clear cache avvisa anche della
possibile purge CDN; disabilitazione e cacheless mode espongono i rispettivi
impatti e finalità temporanea.

## Vulnerabilità Node.js e patch tramite pull request

La pagina `/vulnerabilities` usa gli endpoint specifici:

- `GET .../nodejs/vulnerabilities`, con filtro OpenAPI `severities` costruito
  server-side dai valori `low`, `moderate`, `high`, `critical`, `unknown`;
- `POST .../nodejs/vulnerabilities/patch` con il solo body
  `{ "vulnerability_ids": [...] }`.

Il client valida e riduce la lista a ID, package, versione installata, severity,
CVSS/CVE opzionali, dipendenza diretta/transitiva, patchability, fix version,
stato patch in corso, data e advisory URL HTTPS. Payload grezzi, descrizioni
non usate e campi aggiuntivi non raggiungono il browser.

La selezione UI abilita soltanto elementi patchable non già in patching. Prima
del POST il backend ricarica comunque l’intera lista live e rifiuta ID assenti,
non patchable o già inclusi in una patch. Una sola patch può essere attiva per
sito; idempotenza e concorrenza sono durevoli in `hostinger_operations` e non
esistono retry automatici della mutazione.

La risposta 201 viene ridotta agli ID effettivamente inclusi, numero PR,
branch sanificato e link PR HTTPS con host GitHub e path `/pull/{numero}`
allowlisted. Branch e URL non vengono auditati. La UI dichiara soltanto che
Hostinger ha aperto una pull request da revisionare e unire; non dichiara le
vulnerabilità risolte. I casi archive/non disponibile (404), GitHub App senza
write access (403), selezione non patchable o PR già aperta (422), rate limit e
timeout producono messaggi controllati con reference ID.

Cache e vulnerabilità riusano integralmente `hostinger_operations`; non è
necessaria una migration `0005`.

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
10. In Vercel → Project → Settings → Environment Variables aggiungi
    `HOSTINGER_API_TOKEN`, `HOSTINGER_ACCOUNT_USERNAME` e
    `HOSTINGER_SITE_DOMAIN` a **Production**, tutte nello stesso intervento.
    Il dominio deve essere un hostname senza `https://`, path o porta.
11. Avvia un nuovo deployment Production.
12. Accedi come OWNER, apri `/onboarding`, premi **Verifica sito Hostinger** e
    controlla il riepilogo della sola corrispondenza.
13. Digita il dominio mostrato, premi **Conferma e importa sito** e verifica il
    redirect a `/overview`.
14. Verifica login, cookie sicuri, logout e pagine protette.
15. Per un futuro dominio personalizzato dell’app, aggiorna `APP_URL` e avvia
    un ulteriore redeploy.

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

- Build e log sono esclusivamente read-only; deploy da archivio, DNS,
  registrar, sottodomini, alias, cron e altre mutazioni non elencate nelle
  capability implementate non sono disponibili.
- Le operazioni account-wide o non associabili con certezza al sito
  configurato restano negate per tutti.
- Email delivery e recupero password non sono configurati.
- La sincronizzazione Hostinger reale deve essere provata con un token di staging/non distruttivo.
- Preview e Production devono usare database e secret appropriati ai rispettivi ambienti.
- I test automatici usano mock completi e non effettuano chiamate Hostinger o
  Neon Production.
- La release corrente non espone un pulsante di riverifica dopo
  l’onboarding; una fase successiva dovrà includere un health check
  OWNER sicuro da usare anche durante la rotazione del token.

## Prossima fase suggerita

Validare build, log, restart, database, cache e vulnerabilità con un account di
staging controllato, osservando paginazione, post-filtro del dominio,
consistenza successiva alla creazione, repair asincrona, link phpMyAdmin,
IPv4/IPv6, cooldown, replay idempotente, disponibilità GitHub e rate limit
reali. Progettare deploy da archivio, DNS e ogni altra capability soltanto in
fasi separate, mantenendo il confine single-site e il default-deny.
