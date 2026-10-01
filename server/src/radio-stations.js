/**
 * Hand-picked French stations shown first on the Radios page. Every `url` is the broadcaster's own
 * stream, checked one by one on 2026-10-01 (HTTP 200, audio/mpeg, audio bytes received).
 * Logos (checked: HTTP 200 image/png): official sites or Wikimedia; null = initials on the station's colour.
 * Only these URLs and Radio Browser's directory can be relayed (radio.js): never a client URL.
 */

const RF = (s) => `https://icecast.radiofrance.fr/${s}-midfi.mp3`;
const WIKI_FIP = 'https://upload.wikimedia.org/wikipedia/fr/thumb/d/d5/FIP_logo_2005.svg/250px-FIP_logo_2005.svg.png';

// [id, name, group, tags, url, homepage, logo, colour]
const LIST = [
  ['franceinter', 'France Inter', 'Radio France', 'généraliste,info,culture', RF('franceinter'), 'https://www.radiofrance.fr/franceinter', null, '#e2001a'],
  ['franceinfo', 'franceinfo', 'Radio France', 'info', RF('franceinfo'), 'https://www.radiofrance.fr/franceinfo', null, '#ffc800'],
  ['franceculture', 'France Culture', 'Radio France', 'culture,talk', RF('franceculture'), 'https://www.radiofrance.fr/franceculture', 'https://upload.wikimedia.org/wikipedia/fr/thumb/c/c9/France_Culture_-_2008.svg/250px-France_Culture_-_2008.svg.png', '#7a2a8e'],
  ['francemusique', 'France Musique', 'Radio France', 'classique', RF('francemusique'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fip', 'FIP', 'Radio France', 'éclectique', RF('fip'), 'https://www.radiofrance.fr/fip', WIKI_FIP, '#e2007a'],
  ['mouv', "Mouv'", 'Radio France', 'rap,hip-hop', RF('mouv'), 'https://www.radiofrance.fr/mouv', 'https://upload.wikimedia.org/wikipedia/fr/thumb/d/d3/Le_Mouv%27_logo_2008.svg/250px-Le_Mouv%27_logo_2008.svg.png', '#1d1d1b'],
  ['fbparis', 'ICI Paris', 'Radio France · ICI', 'régional,info', RF('fb1071'), 'https://www.radiofrance.fr/ici/paris', null, '#0a4da2'],
  ['fiprock', 'FIP Rock', 'Radio France · FIP', 'rock', RF('fiprock'), 'https://www.radiofrance.fr/fip/radio-rock', WIKI_FIP, '#e2007a'],
  ['fipjazz', 'FIP Jazz', 'Radio France · FIP', 'jazz', RF('fipjazz'), 'https://www.radiofrance.fr/fip/radio-jazz', WIKI_FIP, '#e2007a'],
  ['fipgroove', 'FIP Groove', 'Radio France · FIP', 'funk,soul', RF('fipgroove'), 'https://www.radiofrance.fr/fip/radio-groove', WIKI_FIP, '#e2007a'],
  ['fipworld', 'FIP Monde', 'Radio France · FIP', 'musiques du monde', RF('fipworld'), 'https://www.radiofrance.fr/fip/radio-monde', WIKI_FIP, '#e2007a'],
  ['fipnouveautes', 'FIP Nouveautés', 'Radio France · FIP', 'éclectique', RF('fipnouveautes'), 'https://www.radiofrance.fr/fip/radio-nouveautes', WIKI_FIP, '#e2007a'],
  ['fipreggae', 'FIP Reggae', 'Radio France · FIP', 'reggae', RF('fipreggae'), 'https://www.radiofrance.fr/fip/radio-reggae', WIKI_FIP, '#e2007a'],
  ['fipelectro', 'FIP Électro', 'Radio France · FIP', 'électro', RF('fipelectro'), 'https://www.radiofrance.fr/fip/radio-electro', WIKI_FIP, '#e2007a'],
  ['fipmetal', 'FIP Metal', 'Radio France · FIP', 'metal', RF('fipmetal'), 'https://www.radiofrance.fr/fip/radio-metal', WIKI_FIP, '#e2007a'],
  ['fippop', 'FIP Pop', 'Radio France · FIP', 'pop', RF('fippop'), 'https://www.radiofrance.fr/fip/radio-pop', WIKI_FIP, '#e2007a'],
  ['fiphiphop', 'FIP Hip-Hop', 'Radio France · FIP', 'hip-hop', RF('fiphiphop'), 'https://www.radiofrance.fr/fip/radio-hip-hop', WIKI_FIP, '#e2007a'],
  ['fipsacrefrancais', 'FIP Sacré français !', 'Radio France · FIP', 'chanson française', RF('fipsacrefrancais'), 'https://www.radiofrance.fr/fip/radio-sacre-francais', WIKI_FIP, '#e2007a'],
  ['fmlajazz', 'France Musique La Jazz', 'Radio France · France Musique', 'jazz', RF('francemusiquelajazz'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fmclassiqueplus', 'France Musique Classique Plus', 'Radio France · France Musique', 'classique', RF('francemusiqueclassiqueplus'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fmbaroque', 'France Musique Baroque', 'Radio France · France Musique', 'classique,baroque', RF('francemusiquebaroque'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fmpianozen', 'France Musique Piano Zen', 'Radio France · France Musique', 'classique,piano,calme', RF('francemusiquepianozen'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fmeasyclassique', 'France Musique Easy Classique', 'Radio France · France Musique', 'classique', RF('francemusiqueeasyclassique'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fmconcerts', 'France Musique Concerts', 'Radio France · France Musique', 'classique,concerts', RF('francemusiqueconcertsradiofrance'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fmcontemporaine', 'France Musique La Contemporaine', 'Radio France · France Musique', 'classique,contemporain', RF('francemusiquelacontemporaine'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fmocora', 'France Musique Ocora Monde', 'Radio France · France Musique', 'musiques du monde', RF('francemusiqueocoramonde'), 'https://www.radiofrance.fr/francemusique', null, '#c4007a'],
  ['fbprovence', 'ICI Provence', 'Radio France · ICI', 'régional', RF('fbprovence'), 'https://www.radiofrance.fr/ici/provence', null, '#0a4da2'],
  ['fbgironde', 'ICI Gironde', 'Radio France · ICI', 'régional', RF('fbgironde'), 'https://www.radiofrance.fr/ici/gironde', null, '#0a4da2'],
  ['fbnord', 'ICI Nord', 'Radio France · ICI', 'régional', RF('fbnord'), 'https://www.radiofrance.fr/ici/nord', null, '#0a4da2'],
  ['fbalsace', 'ICI Alsace', 'Radio France · ICI', 'régional', RF('fbalsace'), 'https://www.radiofrance.fr/ici/alsace', null, '#0a4da2'],
  ['fbloireocean', 'ICI Loire Océan', 'Radio France · ICI', 'régional', RF('fbloireocean'), 'https://www.radiofrance.fr/ici/loire-ocean', null, '#0a4da2'],
  ['fbbreizizel', 'ICI Breizh Izel', 'Radio France · ICI', 'régional', RF('fbbreizizel'), 'https://www.radiofrance.fr/ici/breizh-izel', null, '#0a4da2'],
  ['fbazur', 'ICI Azur', 'Radio France · ICI', 'régional', RF('fbazur'), 'https://www.radiofrance.fr/ici/azur', null, '#0a4da2'],
  ['fboccitanie', 'ICI Occitanie', 'Radio France · ICI', 'régional', RF('fbtoulouse'), 'https://www.radiofrance.fr/ici/occitanie', null, '#0a4da2'],
  ['fbisere', 'ICI Isère', 'Radio France · ICI', 'régional', RF('fbisere'), 'https://www.radiofrance.fr/ici/isere', null, '#0a4da2'],
  ['fbpaysbasque', 'ICI Pays Basque', 'Radio France · ICI', 'régional', RF('fbpaysbasque'), 'https://www.radiofrance.fr/ici/pays-basque', null, '#0a4da2'],
  ['rfi', 'RFI Monde', 'France Médias Monde', 'info,international', 'https://rfimonde64k.ice.infomaniak.ch/rfimonde-64.mp3', 'https://www.rfi.fr/', null, '#c8102e'],
  ['rtl', 'RTL', 'Groupe M6', 'généraliste,info', 'https://icecast.rtl.fr/rtl-1-44-128?listen=webCwsBCggNCQgLDQUGBAcGBg', 'https://www.rtl.fr/', null, '#e30613'],
  ['rtl2', 'RTL2', 'Groupe M6', 'pop,rock', 'https://icecast.rtl2.fr/rtl2-1-44-128?listen=webCwsBCggNCQgLDQUGBAcGBg', 'https://www.rtl2.fr/', null, '#e30613'],
  ['funradio', 'Fun Radio', 'Groupe M6', 'dance,électro', 'https://icecast.funradio.fr/fun-1-44-128?listen=webCwsBCggNCQgLDQUGBAcGBg', 'https://www.funradio.fr/', 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/Logo_Fun_Radio_%282021%29.svg/250px-Logo_Fun_Radio_%282021%29.svg.png', '#00a0e1'],
  ['europe1', 'Europe 1', 'Lagardère', 'généraliste,info', 'https://europe1.lmn.fm/europe1.mp3', 'https://www.europe1.fr/', null, '#e4002b'],
  ['europe2', 'Europe 2', 'Lagardère', 'pop,rock', 'https://europe2.lmn.fm/europe2.mp3', 'https://www.europe2.fr/', null, '#e5007d'],
  ['rfm', 'RFM', 'Lagardère', 'pop,variété', 'https://rfm.lmn.fm/rfm.mp3', 'https://www.rfm.fr/', null, '#0b3d91'],
  ['rmc', 'RMC', 'RMC BFM', 'talk,sport,info', 'https://audio.bfmtv.com/rmcradio_128.mp3', 'https://rmc.bfmtv.com/', null, '#0054a6'],
  ['bfmbusiness', 'BFM Business', 'RMC BFM', 'info,économie', 'https://audio.bfmtv.com/bfmbusiness_128.mp3', 'https://www.bfmtv.com/economie/', 'https://www.bfmtv.com/android-icon-192x192.png', '#003a70'],
  ['nrj', 'NRJ', 'NRJ Group', 'hits,pop', 'https://scdn.nrjaudio.fm/adwz2/fr/30001/mp3_128.mp3', 'https://www.nrj.fr/', null, '#e2001a'],
  ['nostalgie', 'Nostalgie', 'NRJ Group', 'années 80,oldies', 'https://streaming.nrjaudio.fm/oug7girb92oc', 'https://www.nostalgie.fr/', null, '#00539f'],
  ['cheriefm', 'Chérie FM', 'NRJ Group', 'pop,love songs', 'https://streaming.nrjaudio.fm/oubqggj25zuw', 'https://www.cheriefm.fr/', null, '#e5007e'],
  ['rireetchansons', 'Rire & Chansons', 'NRJ Group', 'humour', 'https://streaming.nrjaudio.fm/ou8o8xgk7oiu', 'https://www.rireetchansons.fr/', null, '#f39200'],
  ['skyrock', 'Skyrock', 'Indépendantes', 'rap,hip-hop', 'http://icecast.skyrock.net/s/natio_mp3_128k', 'https://skyrock.fm/', null, '#e3001b'],
  ['nova', 'Radio Nova', 'Indépendantes', 'éclectique', 'https://novazz.ice.infomaniak.ch/novazz-128.mp3', 'https://www.nova.fr/', null, '#1a1a1a'],
  ['tsfjazz', 'TSF Jazz', 'Indépendantes', 'jazz', 'https://tsfjazz.ice.infomaniak.ch/tsfjazz-high.mp3', 'https://www.tsfjazz.com/', null, '#d4a017'],
  ['radioclassique', 'Radio Classique', 'Indépendantes', 'classique', 'https://radioclassique.ice.infomaniak.ch/radioclassique-high.mp3', 'https://www.radioclassique.fr/', null, '#8c1d40'],
  ['ouifm', 'OÜI FM', 'Indépendantes', 'rock', 'https://ouifm.ice.infomaniak.ch/ouifm-high.mp3', 'https://www.ouifm.fr/', null, '#111111'],
  ['latina', 'Latina', 'Indépendantes', 'latino', 'https://start-latina.ice.infomaniak.ch/start-latina-high.mp3', 'https://www.latina.fr/', null, '#e6007e'],
  ['jazzradio', 'Jazz Radio', 'Indépendantes', 'jazz', 'https://jazzradio.ice.infomaniak.ch/jazzradio-high.mp3', 'https://www.jazzradio.fr/', 'https://www.jazzradio.fr/apple-touch-icon-120x120.png', '#2b2b2b'],
  ['radiofg', 'Radio FG', 'Indépendantes', 'électro,house', 'https://radiofg.impek.com/fg', 'https://www.radiofg.com/', null, '#ff0066'],
  ['radiomeuh', 'Radio Meuh', 'Indépendantes', 'éclectique', 'https://radiomeuh.ice.infomaniak.ch/radiomeuh-128.mp3', 'https://www.radiomeuh.com/', null, '#3c8d40'],
  ['sudradio', 'Sud Radio', 'Indépendantes', 'talk,info', 'https://start-sud.ice.infomaniak.ch/start-sud-high.mp3', 'https://www.sudradio.fr/', 'https://www.sudradio.fr/wp-content/uploads/2019/06/cropped-favicon-180x180.png', '#e2001a'],
  ['mradio', 'M Radio', 'Indépendantes', 'chanson française', 'https://mfm.ice.infomaniak.ch/mfm-128.mp3', 'https://www.mradio.fr/', null, '#d6006f'],
  ['voltage', 'Voltage', 'Indépendantes', 'hits', 'https://start-voltage.ice.infomaniak.ch/start-voltage-high.mp3', 'https://www.voltage.fr/', null, '#ffcc00'],
  ['generations', 'Générations', 'Indépendantes', 'rap,r&b', 'https://generationfm.ice.infomaniak.ch/generationfm-high.mp3', 'https://generations.fr/', null, '#111111'],
  ['beurfm', 'Beur FM', 'Indépendantes', 'musique arabe', 'https://beurfm.ice.infomaniak.ch/beurfm-high.mp3', 'https://www.beurfm.net/', null, '#00843d'],
  ['hotmixdance', 'Hotmix Dance', 'Indépendantes', 'dance', 'https://streaming.hotmixradio.fr/hotmixradio-dance-128.mp3', 'https://hotmixradio.com/', null, '#ff5a00'],
];

export const FEATURED = LIST.map(([id, name, group, tags, url, homepage, logo, color]) => ({
  id: `fr-${id}`, name, group, tags: tags.split(','), url, homepage, logo, color,
  country: 'France', countryCode: 'FR', language: 'french', codec: null, bitrate: null,
}));

export const FEATURED_BY_ID = new Map(FEATURED.map((s) => [s.id, s]));
