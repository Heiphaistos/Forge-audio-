/**
 * Screen layouts (Paramètres > Apparence > Disposition): each one is a `data-layout` value on `.app`, styled in
 * styles.css (wide screens only, phones keep their own layout). `preview` draws the thumbnail of the picker:
 * s = side menu, m = main, p = player bar, f = floating player.
 */
export const LAYOUTS = [
  { id: 'classique', name: 'Classique', hint: 'Menu à gauche, lecteur en bas', preview: { cols: '1fr 3fr', rows: '4fr 1fr', areas: ['s m', 'p p'] } },
  { id: 'miroir', name: 'Miroir', hint: 'Menu à droite, file d’attente à gauche', preview: { cols: '3fr 1fr', rows: '4fr 1fr', areas: ['m s', 'p p'] } },
  { id: 'haut', name: 'Lecteur en haut', hint: 'La barre de lecture passe au-dessus', preview: { cols: '1fr 3fr', rows: '1fr 4fr', areas: ['p p', 's m'] } },
  { id: 'inverse', name: 'Inversé', hint: 'Lecteur en haut et menu à droite', preview: { cols: '3fr 1fr', rows: '1fr 4fr', areas: ['p p', 'm s'] } },
  { id: 'flottant', name: 'Lecteur flottant', hint: 'Le lecteur flotte au-dessus du contenu', preview: { cols: '1fr 3fr', rows: '4fr 1fr', areas: ['s m', 's f'] } },
  { id: 'rail', name: 'Rail', hint: 'Menu réduit aux icônes, plus de place', preview: { cols: '1fr 7fr', rows: '4fr 1fr', areas: ['s m', 'p p'] } },
  { id: 'immersif', name: 'Immersif', hint: 'Menu escamotable, grand lecteur', preview: { cols: '1fr', rows: '3fr 2fr', areas: ['m', 'p'] } },
  { id: 'focus', name: 'Focus', hint: 'Contenu centré, menu escamotable', preview: { cols: '1fr 6fr 1fr', rows: '4fr 1fr', areas: ['. m .', '. p .'] } },
  { id: 'aere', name: 'Aéré', hint: 'Plus d’espace et de grands éléments', preview: { cols: '2fr 5fr', rows: '3fr 1fr', areas: ['s m', 'p p'], gap: 3 } },
  { id: 'dense', name: 'Dense', hint: 'Compact, un maximum de titres à l’écran', preview: { cols: '1fr 4fr', rows: '6fr 1fr', areas: ['s m', 'p p'], gap: 1 } },
  { id: 'sanscadre', name: 'Sans cadre', hint: 'Panneaux collés, sans marges ni arrondis', preview: { cols: '1fr 3fr', rows: '4fr 1fr', areas: ['s m', 'p p'], gap: 0 } },
] as const;

export type LayoutId = (typeof LAYOUTS)[number]['id'];
export const isLayout = (v: unknown): v is LayoutId => LAYOUTS.some((l) => l.id === v);
