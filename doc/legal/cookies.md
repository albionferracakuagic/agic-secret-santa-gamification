# Cookies Notice / Informativa sui cookie

> **DRAFT for owner / legal review. Not legal advice.**
> Bozza per revisione del titolare / legale.

Secret Santa Games uses **only strictly necessary cookies**. No consent banner is required for them (ePrivacy Directive art. 5(3) exemption; Italian Garante cookie guidelines). If analytics or any non-essential cookie is ever added, this notice and a consent mechanism must be added first.

## English

| Cookie | Who | Purpose | Duration | Notes |
|---|---|---|---|---|
| `sg_p` | Participants | Keeps you signed in to your event entry | 14 days | HttpOnly, SameSite=Lax, Secure in production. Random token; only its hash is stored on our side. |
| `sg_d` | Display screens | Authorises the big-screen display of one event | Until revoked/expired by the organizer | HttpOnly, SameSite=Lax, Secure in production. |
| `sg_o` / Better Auth session cookie | Organizers | Organizer sign-in session | Session / **[7 days]** | HttpOnly, SameSite=Lax, Secure in production. |

Local storage / service worker: the app stores your display preferences (language, sound, effects intensity, reduced motion) on your device only, and a service worker caches the static app shell for faster loading. It never caches event data, results or API responses (`Cache-Control: no-store`).

You can delete cookies in your browser at any time; you will need to re-join with your invitation.

## Italiano

| Cookie | Chi | Finalità | Durata | Note |
|---|---|---|---|---|
| `sg_p` | Partecipanti | Mantiene l'accesso alla tua scheda nell'evento | 14 giorni | HttpOnly, SameSite=Lax, Secure in produzione. Token casuale; sui nostri sistemi è salvato solo l'hash. |
| `sg_d` | Schermi display | Autorizza il display grande di un evento | Fino a revoca/scadenza decisa dall'organizzatore | HttpOnly, SameSite=Lax, Secure in produzione. |
| `sg_o` / cookie di sessione Better Auth | Organizzatori | Sessione di accesso dell'organizzatore | Sessione / **[7 giorni]** | HttpOnly, SameSite=Lax, Secure in produzione. |

Local storage / service worker: l'app salva sul tuo dispositivo solo le preferenze di visualizzazione (lingua, audio, intensità effetti, movimento ridotto) e un service worker memorizza l'interfaccia statica per caricarla più velocemente. Non memorizza mai dati dell'evento, risultati o risposte API (`Cache-Control: no-store`).

Puoi eliminare i cookie dal browser in qualsiasi momento; dovrai rientrare con il tuo invito.
