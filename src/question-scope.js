// A local scope filter, not a model call. The guide supplies the implicit Quake
// context for ordinary player questions; unrelated tasks and other apps do not.
const words = (text) => String(text).toLowerCase().match(/[+-]?[a-z0-9_]+(?:\.[a-z0-9_]+)*/g) || [];
const GENERAL = new Set("a an the how do does did i my me you your it its is are can could should would will have has to of in on off and or for with from at as about what where when why which who use using set change adjust make get find know dont setting settings size style name color colors play playing turn enable disable open run show save saved t s won".split(" "));
const ENGINE = /\b(?:qss[- ]?m|quakespasm(?:[- ]spiked)?|quake(?:\s*1)?)\b/i;
const ENGINE_TOPIC = /\b(?:install\w*|updat\w*|upgrad\w*|download\w*|build\w*|compil\w*|crash\w*|start\w*|support\w*|requirements?|windows|linux|macos|render\w*|versions?|features?|defaults?|settings?|source|code|implement\w*|files?|readme|sdl|input|audio|music|sound|graphics|network|servers?|maps?|mods?|controls?|bindings?|controllers?|menus?|cvars?|licenses?|free|cost|price)\b/i;
const TOPICS = /\b(?:crosshairs?|framerate|frame rate|fps|fov|field of view|hud|vsync|fullscreen|full screen|mouselook|mouse look|autoexec(?:\.cfg)?|config\.cfg|id1|pak[01]\.pak|mission packs?|mods?|gamepad|controller|joystick|multiplayer|deathmatch|teamplay|skybox|textures?|anisotrop\w*|mipmaps?|demos?|demo playback|screenshots?|packet loss|strafe jumping|bunny hopping|dedicated server|console (?:commands?|variables?|font|text)|mouse sensitivity|invert (?:the |my )?mouse|weapon model|sound crackl\w*)\b/i;
const CONTROL = /\b(?:change|adjust|set|enable|disable|turn|mute|unmute|lower|raise|increase|decrease|limit|uncap|invert|bind|reset|restore|save|load|hide|show|pause|resume|restart)\b/i;
const CONTROLLABLE = /\b(?:music|volume|sound|audio|mouse|gamma|brightness|contrast|resolution|controls?|bindings?|settings?|defaults?|player name|player colors?)\b/i;
const topicWords = (text) => words(String(text).replace(new RegExp(ENGINE.source, "gi"), ""));

// Explicit non-guide context takes precedence even when a prompt also includes
// an engine name or a real setting (e.g. "fov in Valorant").
const OTHER_CONTEXT = [
  /\b(?:valorant|fortnite|minecraft|roblox|overwatch|counter[- ]strike|cs2|apex legends|call of duty|quake (?:ii|iii|iv|2|3|4)|zoom|microsoft teams|powerpoint|excel|photoshop|spotify)\b/i,
  /\b(?:poem|poetry|essay|recipe|recipes|horoscope|stock price|stock market|capital of|customer service|president|prime minister)\b/i,
  /\b(?:weather|forecast)\b.*\b(?:today|tomorrow|tonight|in [a-z])\b/i,
  /\b(?:earthquake|quake)\b.*\b(?:san francisco|movie|film)\b/i,
  /\b(?:music|record|demo|connect)\b.*\b(?:party|product|zoom|customer service)\b/i,
  /\b(?:watch|stream)\b.*\b(?:product demo|movie|film)\b/i,
  /\b(?:what time|when)\b.*\b(?:tournament|party|match)\b.*\b(?:tonight|today|start)\b/i,
];

export function createQuestionClassifier({ entries, faq, hasSourceSymbol = () => false }) {
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const files = new Set(entries.map((entry) => entry.file?.split("/").pop()?.toLowerCase()).filter(Boolean));
  const prefixes = new Set(entries.map((entry) => entry.name.match(/^[a-z]+_/i)?.[0]?.toLowerCase()).filter(Boolean));
  const titles = faq.map((answer) => new Set(topicWords(answer.question).filter((word) => !GENERAL.has(word))));
  const exactQuestions = new Set(faq.map((answer) => topicWords(answer.question).join(" ")));
  return (question) => {
    const terms = topicWords(question);
    if (OTHER_CONTEXT.some((pattern) => pattern.test(question))) return false;
    if (ENGINE.test(question) && (ENGINE_TOPIC.test(question) ||
      !terms.some((term) => !GENERAL.has(term)))) return true;
    if (!terms.length) return false;
    if (exactQuestions.has(terms.join(" "))) return true;
    if (terms.some((term) => files.has(term) ||
      (/[_.]/.test(term) && (names.has(term) || hasSourceSymbol(term) || prefixes.has(term.match(/^[a-z]+_/)?.[0]))) ||
      (/^[+-]/.test(term) && names.has(term)))) return true;
    // Generic names such as "record" or "color" are meaningful as explicit
    // console questions or standalone lookups, not incidental prose matches.
    if (terms.length === 1 && names.has(terms[0])) return true;
    const lookup = question.toLowerCase().trim().replace(/[?!.]+$/, "").replace(/^(?:what is|what does|how does)\s+/, "").replace(/\s+(?:do|work)$/, "").replace(/`/g, "");
    if (names.has(lookup)) return true;
    if (/\b(?:console|commands?|cvars?|variables?|launch options?)\b/i.test(question) && terms.some((term) => names.has(term))) return true;
    if (TOPICS.test(question) || CONTROL.test(question) && CONTROLLABLE.test(question)) return true;
    if (/\b(?:join|host|connect to)\b.*\bserver\b/i.test(question)) return true;
    if (/\bgame\b.*\b(?:crash\w*|stutter\w*)\b/i.test(question)) return true;
    const topic = [...new Set(terms.filter((term) => !GENERAL.has(term)))];
    return titles.some((title) => topic.filter((term) => title.has(term)).length >= 2);
  };
}
