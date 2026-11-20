# Guida per l'organizzatore

> Aggiornata al: 19/11/2026 — **v1.1.0**

## 1. Console organizzatore

La console è divisa in cinque tab; il parametro `?tab=` permette il collegamento diretto.

- **Live**: riepilogo evento, stato/timeline dello Show Autopilot, avvisi e controlli manuali di fase/pausa sotto **Manual override**.
- **Setup**: tempi dell'autopilota, feature, import abbinamenti, reazioni, categorie e achievement personalizzati.
- **People**: link/QR/codici di accesso, registro e approvazioni, rimozione partecipanti.
- **Show**: controlli contestuali per apertura, voto, rivelazione, giochi, classifiche e cerimonia.
- **Admin**: statistiche aggregate, integrità, moderazione, audit unmask, archivio e audit log.

È montato solo il tab attivo. Per riprendere una specifica attività usa il deep link, ad esempio `?tab=setup`.

## 2. Ciclo di vita dell'evento

Fasi (guidate dall'organizzatore): preparazione → registrazione → registrazione regali → apertura regali → votazione → giochi → rivelazione → premi → completato.

- Il comando evento **Pausa/Riprendi** è disponibile in ogni fase ed è distinto da **Hold/Riprendi** dell'autopilota.
- Passi indietro consentiti (con audit) fino all'inizio della rivelazione.
- Reimport degli abbinamenti disabilitato per sempre dopo l'inizio dell'apertura regali.
- Massimo 100 partecipanti per evento.

## 3. File degli abbinamenti

Il sorteggio si fa fuori dall'app; poi si carica il risultato (CSV o XLSX).

- Colonne: donatore e destinatario, per **nome e/o email**. Le intestazioni sono riconosciute in automatico (sinonimi EN/IT: giver/santa/from/donatore, recipient/to/destinatario); mappatura correggibile a mano.
- Separatori `,` e `;` entrambi ok (Excel italiano). Codifiche UTF-8, UTF-16, CP1252 rilevate. XLSX: scelta del foglio.
- Abbinamento al registro: email (senza distinzione maiuscole), altrimenti nome normalizzato (senza accenti/maiuscole). Nomi sconosciuti → nuove voci non reclamate.
- Errori (bloccano "pronto"): auto-abbinamento, righe duplicate, nome ambiguo, donatore con più di un destinatario.
- Avvisi: destinatario con 0 o >1 donatori, voce di registro senza abbinamento.
- Stato: bozza (problemi aperti) o pronto. **Serve "pronto" per passare da preparazione a registrazione regali.**
- Il file originale non viene conservato. Il risultato mostra solo conteggi e problemi per numero di riga; le coppie restano nascoste.

## 4. Accesso, reclami e codici

- Condividi QR/link dell'evento o codice breve (con limite di tentativi e scadenza). La pagina di accesso rileva EN/IT.
- I partecipanti reclamano il proprio nome in uno di questi modi:
  1. link personale via email (se nel registro c'è l'email);
  2. codice personale (esporta l'elenco nome+codice; non contiene abbinamenti);
  3. scelta del nome → in attesa → approvazione di persona da parte tua.
- L'auto-approvazione dà solo accesso base, mai segreti. Una sola sessione attiva per voce; reclamare da un nuovo dispositivo revoca la precedente (con audit).
- Il display usa un token proprio, revocabile.

## 5. Privacy del voto

- I risultati di una categoria sono pubblicati solo con **≥5 votanti distinti**. Soglie fisse, non abbassabili.
- Con **<10 votanti** la classifica live è spenta di default (risultati a chiusura/cerimonia); puoi attivarla.
- Le classifiche mostrano solo i primi N: nessun totale, nessun ultimo posto, nessun "chi ha votato". Il contatore "N hanno votato" si aggiorna ogni ~10 s.
- Se una categoria non supera la soglia viene saltata con un messaggio neutro "magia di Natale"; i riconoscimenti di partecipazione restano.
- Eventi molto piccoli (<5 votanti): nessun vincitore da voti; sei avvisato in fase di setup.
- I vincitori si bloccano alla chiusura del voto. Riaprire il voto invalida i premi bloccati (con audit).

## 6. Show Autopilot

Lo Show Autopilot è facoltativo. **Start Show** è nel tab **Live** ed è disponibile dall'apertura regali (oppure da una fase successiva se lo avvii manualmente), quando l'evento non è in pausa. I controlli pronti all'avvio richiedono:

- l'ultimo import abbinamenti in stato **ready**;
- almeno un regalo registrato;
- il canale realtime pubblico del client organizzatore attivo (non prova che uno schermo `/d` sia aperto);
- le feature nell'event state organizzatore;
- una fase show consentita (`apertura regali` fino a `premi`).

Il server esegue apertura → votazione → giochi facoltativi → rivelazione → premi → completato tramite job durevoli. Usa l'orologio server e lo stato reale dell'evento, non un timer del browser.

### Preset di ritmo e override

Scegli il preset in **Setup**:

| Ritmo | Apertura / regalo | Votazione | Giochi | Rivelazione / regalo | Intervallo |
|---|---:|---:|---:|---:|---:|
| Veloce | 20 s | 3 min | 5 min | 12 s | 5 s |
| Standard | 40 s | 5 min | 10 min | 20 s | 10 s |
| Rilassato | 60 s | 10 min | 15 min | 30 s | 20 s |

Ogni tempo è sostituibile. Lascia il campo vuoto (o imposta `null` via API) per tornare al preset selezionato. Intervalli ammessi: apertura 5–600 s, votazione e giochi 1–120 min, rivelazione 5–300 s, intervallo 0–120 s. **Includi extra** decide se mini-giochi/asta abilitati entrano nel passo giochi; soglie privacy e permessi delle feature non sono modificabili qui.

Le impostazioni restano modificabili fino al completamento. Se lo spettacolo è in corso, la modifica riallinea la stima della timeline; il server legge sempre il tempo effettivo più recente al successivo passo.

### Hold, freeze e controllo manuale

- **Hold** sospende solo la timeline dell'autopilota. Voti, reazioni e le altre interazioni restano attive secondo la fase corrente. Riprendi ripristina il tempo residuo.
- Il **freeze** dell'evento (`Pausa`) è diverso: al successivo tick durevole l'autopilota passa in stato held/frozen; anche le normali azioni evento restano soggette ai controlli di pausa. Prima rimuovi la pausa evento, poi riprendi esplicitamente l'autopilota.
- **Salta il passo corrente** termina l'attesa. Non elude le regole irreversibili (ad esempio, prima di uscire dalla votazione il voto viene chiuso).
- **Ferma autopilota** riporta lo spettacolo in gestione manuale; non cambia la fase corrente.
- Un override manuale di fase/azione prevale. Al tick successivo l'autopilota si riallinea alla fase reale ed evita di ripetere l'effetto già eseguito dall'organizzatore.
- I comandi portano la guardia `fromSeq` e i tick durevoli portano `seq`: consegne vecchie o duplicate non producono effetti.

### Auto-risoluzione

L'autopilota non lascia lo spettacolo in attesa di una normale decisione organizzatore:

- i premi pubblicabili in parità configurati per decisione organizzatore diventano **vittorie condivise**, prima di avviare la cerimonia;
- una votazione sotto la soglia privacy non modificabile viene comunque chiusa, ma le categorie restano nascoste/neutre;
- i passi senza contenuto o senza funzioni abilitate vengono saltati.

Se una cerimonia è stata **annullata**, l'autopilota resta in polling e **non la riavvia**. Ferma l'autopilota oppure completa manualmente la gestione: il riavvio automatico è intenzionalmente escluso.

## 7. Cerimonia e percorsi di rivelazione

Passi guidati dalla console organizzatore e replicati sul display: candidati → vincitori → achievement. Gli achievement si sbloccano solo al passo di cerimonia. L'inizio della rivelazione impedisce i passi indietro.

- `/d`: la rivelazione pubblica mette un regalo alla volta sul palco. Il rullo mostra destinatario e countdown, mai il donatore. Solo il job durevole di unveil rende visibile il donatore, poi arriva la griglia finale e il richiamo al riepilogo.
- `/e`: il destinatario vede un banner di rullo personalizzato e, dopo la rivelazione server-side, una schermata personale a tutto schermo con reazioni positive. Per gli altri appare solo una notifica discreta. La chiusura dell'overlay è ricordata nella sessione browser.
- `/e/recap`: il riepilogo è disponibile da premi a completato; prima resta bloccato. Riutilizza solo dati pubblicati (vincitori, donatori già rivelati, dati personali e archivio pubblico), mai voti nascosti o identità non svelate.

## 8. Audit unmask

Giochi in modalità mascherata: abbinamenti, donatori, classifiche complete, dettaglio voti e XP altrui sono nascosti. Per correzioni o verifiche di integrità usa "Audit unmask": conferma + motivo → grant di 10 minuti, banner visibile, voce nel log di audit. Le correzioni agli abbinamenti dopo l'apertura sono possibili solo così, fino alla chiusura del voto.

## 9. Runbook del giorno dell'evento

1. Giorno prima: prova con alcuni dispositivi; verifica abbinamenti **pronti**, categorie attive, evento non in pausa.
2. Display: apri `/d` su schermo/TV 1080p con il token display; schermo intero; controlla che QR/codice breve siano leggibili dalla sala.
3. Audio: i browser bloccano l'audio finché non c'è un clic — tocca "attiva suono" una volta sul display (e sui telefoni, se vuoi). Audio opt-in; il movimento ridotto è rispettato.
4. Scegli: usa **Start Show** da Live oppure gestisci manualmente la scaletta nel tab Show. Con autopilota attivo usa **Hold** per fermare solo la timeline; usa Pausa evento soltanto quando devono bloccarsi anche le azioni dei partecipanti. Controlla il contatore "hanno votato" prima di chiudere.
5. Se un dispositivo cade, la riconnessione ripristina lo stato in automatico.
6. **Nessun deploy o riavvio durante gli eventi.** Blocca i rilasci dal giorno prima.
7. Dopo: fase → completato; le foto seguono la policy di retention.

## 10. Funzioni Phase 2–3

- **Pannello feature flag**: attiva/disattiva funzioni per evento (es. guessSanta, missions; entrambe spente di default).
- **Indovina Babbo Natale**: i partecipanti indovinano il proprio donatore; risultati pubblicati solo tramite il filtro privacy.
- **Missioni**: sfide opzionali; il loro XP non è qualificante (non incide sui premi).
- **Giochi**: mini-giochi nella fase giochi.
- **Monete e asta**: le Santa Coins si guadagnano nell'evento e si spendono all'asta; il conto alla rovescia dipende dall'offset dell'orologio realtime.
- **Storico / Hall of Fame**: eventi e vincitori passati; i partecipanti possono collegare l'account.
- **Certificati**: PDF per partecipanti/vincitori. Achievement custom: assegnati per regola; form di assegnazione manuale non ancora disponibile.
