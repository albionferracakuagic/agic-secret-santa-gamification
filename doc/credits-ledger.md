# Credits ledger — santa-gamification

Registro versionato dei crediti (premium requests) consumati dalle sessioni Copilot CLI
su questo progetto. Una riga per sessione, aggiunta a fine sessione con:

```powershell
node scripts/credits/credits-report.mjs --append-ledger
```

**Crediti** = `SUM(request_multiplier)`, la metrica fatturata da GitHub (opus-5 = 15x, sonnet-5 = 1x).  
**AIU** = `SUM(total_nano_aiu)/1e9`, metrica secondaria di costo.

> **Consuntivo per difetto.** Le righe di consumo vengono scritte a fine turno, quindi
> l'ultimo turno di ogni sessione — quello che esegue il comando qui sopra — non è mai
> incluso nella riga che sta scrivendo. Lo scarto è di un turno per sessione ed è
> strutturale, non correggibile: questi totali sono un **minimo certo**, non un valore
> esatto. Dichiaralo se usi queste cifre per una rendicontazione.

| Data | Sessione | Durata | Crediti | AIU | Modelli | Agenti | Attività |
|---|---|---|---|---|---|---|---|
| 2026-11-16 | d4d975ea | <1m | 5,00 | 18,91 | sonnet-5.5 x5 | main x5 | Initialize SLCE AI Team |
| 2026-11-16 | 5ff9e097 | 37h 52m | 1.789,00 | 9.728,19 | sonnet-5.5 x1450, opus-5.5 x22, gpt-6.1-sol x9 | 607700 x500, main x236, 5e0332 x228, bbeb19 x177, +37 | Create Secret Santa Games Plan |
| 2026-11-18 | 11d2ebbf | 27h 35m | 5.200,00 | 2.196,42 | opus-5.5 x323, mai-code-2 x228, sonnet-5.5 x142 | main x141, 08277c x79, 9f2ad4 x75, a8abed x59, +20 | Fix Organizer Login Failure |
