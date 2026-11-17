export interface MissionDef {
  key: string;
  title: { en: string; it: string };
  description: { en: string; it: string };
}

/**
 * In-house secret-mission catalog (FR-028): safe, inclusive and entirely voluntary. No physical contact, no
 * alcohol, nothing about appearance/age/health/family/money, nothing that needs another person's property or
 * puts someone on the spot. Every mission can be done by anyone, sitting down, in any language.
 */
export const MISSION_CATALOG: readonly MissionDef[] = [
  m(
    'compliment_three',
    'Kind words',
    'Parole gentili',
    'Give a sincere compliment about something someone did or chose today to three different people.',
    'Fai un complimento sincero su qualcosa che hanno fatto o scelto oggi a tre persone diverse.',
  ),
  m(
    'toast_to_all',
    'A toast for everyone',
    'Un brindisi per tutti',
    'Propose a short, friendly toast to the whole group.',
    'Proponi un breve brindisi amichevole a tutto il gruppo.',
  ),
  m(
    'christmas_memory',
    'Memory lane',
    'Un ricordo di Natale',
    'Ask someone to share a happy Christmas memory and listen to the whole story.',
    'Chiedi a qualcuno di raccontare un bel ricordo di Natale e ascolta la storia fino in fondo.',
  ),
  m(
    'thank_someone',
    'Thank you!',
    'Grazie!',
    'Thank someone for something small they did that made the event nicer.',
    'Ringrazia qualcuno per una piccola cosa che ha reso la serata più bella.',
  ),
  m(
    'new_friend',
    'Say hello',
    'Un nuovo amico',
    'Start a conversation with someone you rarely talk to and learn one new thing about them.',
    'Inizia una conversazione con qualcuno con cui parli di rado e scopri una cosa nuova su di lui o lei.',
  ),
  m(
    'festive_word',
    'Word of the night',
    'La parola della serata',
    'Use the word "snowflake" naturally in a conversation without anyone noticing.',
    'Usa la parola "fiocco di neve" in modo naturale in una conversazione senza che nessuno se ne accorga.',
  ),
  m(
    'carol_hum',
    'Carol in the air',
    'Un canto nell’aria',
    'Hum the first bars of a Christmas tune and see if someone joins in.',
    'Canticchia le prime note di una canzone di Natale e vedi se qualcuno si unisce.',
  ),
  m(
    'joke_teller',
    'Cracker joke',
    'La battuta natalizia',
    'Tell a clean, friendly Christmas joke to a small group.',
    'Racconta una battuta natalizia pulita e simpatica a un piccolo gruppo.',
  ),
  m(
    'help_serve',
    'Helping hand',
    'Una mano d’aiuto',
    'Offer to help with something practical: pass a plate, refill a glass of water, find a chair.',
    'Offri il tuo aiuto per qualcosa di pratico: passare un piatto, riempire un bicchiere d’acqua, trovare una sedia.',
  ),
  m(
    'group_photo',
    'Say cheese',
    'Foto di gruppo',
    'Suggest a group photo and make sure everyone who wants to be in it is included.',
    'Proponi una foto di gruppo e assicurati che chi vuole esserci sia incluso.',
  ),
  m(
    'favorite_tradition',
    'Tradition swap',
    'Scambio di tradizioni',
    'Ask two people about a Christmas tradition in their family and share one of yours.',
    'Chiedi a due persone una tradizione natalizia della loro famiglia e racconta una delle tue.',
  ),
  m(
    'movie_vote',
    'Movie night',
    'Serata cinema',
    'Find out the favourite Christmas movie of three people.',
    'Scopri il film di Natale preferito di tre persone.',
  ),
  m(
    'gift_wish',
    'A small wish',
    'Un piccolo desiderio',
    'Wish a good holiday to someone and add one thing you hope they enjoy this season.',
    'Fai gli auguri a qualcuno aggiungendo una cosa che speri possa godersi in questa stagione.',
  ),
  m(
    'recipe_ask',
    'Recipe hunt',
    'A caccia di ricette',
    'Ask someone for the recipe of a festive dish they love.',
    'Chiedi a qualcuno la ricetta di un piatto natalizio che ama.',
  ),
  m(
    'quiet_corner',
    'Include everyone',
    'Nessuno escluso',
    'Invite someone who is standing a bit apart to join your conversation.',
    'Invita nella tua conversazione qualcuno che sta un po’ in disparte.',
  ),
  m(
    'festive_accessory',
    'Festive touch',
    'Tocco di festa',
    'Wear or hold something festive (a hat, a ribbon, a pin) for a while and enjoy the smiles.',
    'Indossa o tieni in mano qualcosa di festoso (cappello, nastro, spilla) per un po’ e goditi i sorrisi.',
  ),
  m(
    'storyteller',
    'One-line story',
    'Storia in una riga',
    'Start a story with "Once upon a Christmas…" and let two others add a sentence each.',
    'Inizia una storia con "C’era una volta un Natale…" e fai aggiungere una frase a due persone.',
  ),
  m(
    'applause_starter',
    'Applause starter',
    'Applauso a sorpresa',
    'Be the first to start a friendly round of applause after a gift is opened.',
    'Sii il primo a far partire un applauso amichevole dopo l’apertura di un regalo.',
  ),
  m(
    'wish_list_free',
    'Wish for the world',
    'Un desiderio per il mondo',
    'Ask three people what they would wish for the world this Christmas.',
    'Chiedi a tre persone che desiderio esprimerebbero per il mondo a Natale.',
  ),
  m(
    'memory_game',
    'Name game',
    'Gioco dei nomi',
    'Learn the name of someone you have just met and use it in a sentence.',
    'Impara il nome di qualcuno che hai appena conosciuto e usalo in una frase.',
  ),
  m(
    'good_news',
    'Good news',
    'Buone notizie',
    'Ask someone to share one piece of good news from their year.',
    'Chiedi a qualcuno di condividere una buona notizia del suo anno.',
  ),
  m(
    'snack_share',
    'Share the treats',
    'Dolcetti da condividere',
    'Offer a treat from the table to someone who has not tried it yet.',
    'Offri un dolcetto dal tavolo a qualcuno che non l’ha ancora assaggiato.',
  ),
  m(
    'emoji_wish',
    'Pictures of joy',
    'Immagini di gioia',
    'Describe your favourite part of the evening using only three words and ask someone to do the same.',
    'Descrivi la parte che ti piace di più della serata in sole tre parole e chiedi a qualcuno di fare lo stesso.',
  ),
  m(
    'lights_story',
    'Lights and decorations',
    'Luci e decorazioni',
    'Find the decoration you like most and tell someone why.',
    'Trova la decorazione che ti piace di più e racconta a qualcuno perché.',
  ),
  m(
    'future_toast',
    'Next year',
    'Il prossimo anno',
    'Ask two people what they are looking forward to next year.',
    'Chiedi a due persone cosa aspettano con più gioia l’anno prossimo.',
  ),
];

function m(
  key: string,
  titleEn: string,
  titleIt: string,
  descEn: string,
  descIt: string,
): MissionDef {
  return {
    key,
    title: { en: titleEn, it: titleIt },
    description: { en: descEn, it: descIt },
  };
}

export const MISSION_KEYS = MISSION_CATALOG.map((x) => x.key);

export const missionByKey = (key: string) => MISSION_CATALOG.find((x) => x.key === key);

export interface MissionAssignment {
  participantId: string;
  missionKey: string;
}

/**
 * Random assignment: each participant is topped up to `perParticipant` missions with distinct catalog entries
 * (never one they already hold or held). `existing` maps participant -> keys already used. Pure given `rng`.
 */
export function planMissionAssignments(
  participantIds: readonly string[],
  perParticipant: number,
  existing: ReadonlyMap<string, ReadonlySet<string>>,
  open: ReadonlyMap<string, number>,
  rng: () => number,
): MissionAssignment[] {
  const out: MissionAssignment[] = [];
  for (const pid of participantIds) {
    const used = new Set(existing.get(pid) ?? []);
    const need = Math.max(0, perParticipant - (open.get(pid) ?? 0));
    const pool = MISSION_KEYS.filter((k) => !used.has(k));
    for (let i = 0; i < need && pool.length > 0; i++) {
      const k = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
      out.push({ participantId: pid, missionKey: k });
    }
  }
  return out;
}

/** Picks a different mission for a reassignment (null when the catalog is exhausted for this person). */
export function pickReplacement(used: ReadonlySet<string>, rng: () => number): string | null {
  const pool = MISSION_KEYS.filter((k) => !used.has(k));
  return pool.length ? pool[Math.floor(rng() * pool.length)]! : null;
}
