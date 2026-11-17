# Guida per l'organizzatore

> Aggiornata al: 17/11/2026 — **MVP**

## 1. Ciclo di vita dell'evento

Fasi (guidate dall'organizzatore): preparazione → registrazione → registrazione regali → apertura regali → votazione → giochi (saltata nell'MVP) → rivelazione → premi → completato.

- Pausa/ripresa disponibile in ogni fase.
- Passi indietro consentiti (con audit) fino all'inizio della rivelazione.
- Reimport degli abbinamenti disabilitato per sempre dopo l'inizio dell'apertura regali.
- Massimo 100 partecipanti per evento.

## 2. File degli abbinamenti

Il sorteggio si fa fuori dall'app; poi si carica il risultato (CSV o XLSX).

- Colonne: donatore e destinatario, per **nome e/o email**. Le intestazioni sono riconosciute in automatico (sinonimi EN/IT: giver/santa/from/donatore, recipient/to/destinatario); mappatura correggibile a mano.
- Separatori `,` e `;` entrambi ok (Excel italiano). Codifiche UTF-8, UTF-16, CP1252 rilevate. XLSX: scelta del foglio.
- Abbinamento al registro: email (senza distinzione maiuscole), altrimenti nome normalizzato (senza accenti/maiuscole). Nomi sconosciuti → nuove voci non reclamate.
- Errori (bloccano "pronto"): auto-abbinamento, righe duplicate, nome ambiguo, donatore con più di un destinatario.
- Avvisi: destinatario con 0 o >1 donatori, voce di registro senza abbinamento.
- Stato: bozza (problemi aperti) o pronto. **Serve "pronto" per passare da preparazione a registrazione regali.**
- Il file originale non viene conservato. Il risultato mostra solo conteggi e problemi per numero di riga; le coppie restano nascoste.

## 3. Accesso, reclami e codici

- Condividi QR/link dell'evento o codice breve (con limite di tentativi e scadenza). La pagina di accesso rileva EN/IT.
- I partecipanti reclamano il proprio nome in uno di questi modi:
  1. link personale via email (se nel registro c'è l'email);
  2. codice personale (esporta l'elenco nome+codice; non contiene abbinamenti);
  3. scelta del nome → in attesa → approvazione di persona da parte tua.
- L'auto-approvazione dà solo accesso base, mai segreti. Una sola sessione attiva per voce; reclamare da un nuovo dispositivo revoca la precedente (con audit).
- Il display usa un token proprio, revocabile.

## 4. Privacy del voto

- I risultati di una categoria sono pubblicati solo con **≥5 votanti distinti**. Soglie fisse, non abbassabili.
- Con **<10 votanti** la classifica live è spenta di default (risultati a chiusura/cerimonia); puoi attivarla.
- Le classifiche mostrano solo i primi N: nessun totale, nessun ultimo posto, nessun "chi ha votato". Il contatore "N hanno votato" si aggiorna ogni ~10 s.
- Se una categoria non supera la soglia viene saltata con un messaggio neutro "magia di Natale"; i riconoscimenti di partecipazione restano.
- Eventi molto piccoli (<5 votanti): nessun vincitore da voti; sei avvisato in fase di setup.
- I vincitori si bloccano alla chiusura del voto. Riaprire il voto invalida i premi bloccati (con audit).

## 5. Cerimonia

Passi guidati dalla console organizzatore e replicati sul display: candidati → vincitori → achievement. Gli achievement si sbloccano solo al passo di cerimonia. L'inizio della rivelazione impedisce i passi indietro.

## 6. Audit unmask

Giochi in modalità mascherata: abbinamenti, donatori, classifiche complete, dettaglio voti e XP altrui sono nascosti. Per correzioni o verifiche di integrità usa "Audit unmask": conferma + motivo → grant di 10 minuti, banner visibile, voce nel log di audit. Le correzioni agli abbinamenti dopo l'apertura sono possibili solo così, fino alla chiusura del voto.

## 7. Runbook del giorno dell'evento

1. Giorno prima: prova con alcuni dispositivi; verifica abbinamenti **pronti**, categorie attive, evento non in pausa.
2. Display: apri `/d` su schermo/TV 1080p con il token display; schermo intero; controlla che QR/codice breve siano leggibili dalla sala.
3. Audio: i browser bloccano l'audio finché non c'è un clic — tocca "attiva suono" una volta sul display (e sui telefoni, se vuoi). Audio opt-in; il movimento ridotto è rispettato.
4. Esegui le fasi in ordine e annuncia ogni cambio. Controlla il contatore "hanno votato" prima di chiudere.
5. Se un dispositivo cade, la riconnessione ripristina lo stato in automatico.
6. **Nessun deploy o riavvio durante gli eventi.** Blocca i rilasci dal giorno prima.
7. Dopo: fase → completato; le foto seguono la policy di retention.
