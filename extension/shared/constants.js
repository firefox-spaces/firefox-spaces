export const DEFAULT_STORE = 'firefox-default';

export const NEWTAB_URLS = ['about:newtab', 'about:home', 'about:privatebrowsing'];

export const SPACE_COLORS = [
  '#5e81f4', // blue
  '#e5484d', // red
  '#f76b15', // orange
  '#e2a400', // amber
  '#30a46c', // green
  '#12a594', // teal
  '#8e4ec6', // purple
  '#d6409f', // pink
  '#7c7b74', // stone
];

// Firefox only accepts these names for container colors.
export const CONTAINER_COLORS = {
  blue: '#37adff',
  turquoise: '#00c79a',
  green: '#51cd00',
  yellow: '#ffcb00',
  orange: '#ff9f00',
  red: '#ff613d',
  pink: '#ff4bda',
  purple: '#af51f5',
  toolbar: '#7c7c7d',
};

export const CONTAINER_ICONS = [
  'fingerprint', 'briefcase', 'dollar', 'cart', 'circle', 'gift',
  'vacation', 'food', 'fruit', 'pet', 'tree', 'chill', 'fence',
];

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export const EXPIRY_OPTIONS = [
  { label: '12 hours', ms: 12 * HOUR },
  { label: '24 hours', ms: DAY },
  { label: '7 days', ms: 7 * DAY },
  { label: '30 days', ms: 30 * DAY },
  { label: 'Never', ms: 0 },
];

export const DEFAULT_SETTINGS = {
  expiryMs: 30 * DAY,
  archiveRetentionMs: 30 * DAY,
  tintWindow: true,
  tabBarTipDismissed: false,
  profileBackup: false,
};

// Keep in sync with extras/userChrome.css.
export const USERCHROME_CSS = `/* Spaces: hide Firefox's horizontal tab strip */
#TabsToolbar { visibility: collapse !important; }

/* Spaces: hide the sidebar's title bar.
   Old sidebar: Firefox sometimes labels it with another extension's name (e.g.
   Bitwarden) while Spaces is open, so match every extension sidebar, not just ours;
   native sidebars (Bookmarks, History) keep their header there.
   New sidebar (Firefox 136+, sidebar.revamp): the header is #sidebar-panel-header
   and carries no extension marker, so it is hidden for every panel. */
#sidebar-box[sidebarcommand$="-sidebar-action"] #sidebar-header,
#sidebar-panel-header {
  display: none !important;
}

/* Spaces: hide the container (profile) label in the address bar */
#userContext-icons { display: none !important; }
`;

export const USERCHROME_PREF = 'toolkit.legacyUserProfileCustomizations.stylesheets';
