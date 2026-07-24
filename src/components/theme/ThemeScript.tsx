/**
 * Stamps data-theme on <html> before the first paint.
 *
 * Without this the page renders in the default theme for one frame and then
 * snaps to the stored preference — a white flash on every navigation for anyone
 * using dark mode. It has to be a blocking inline script; anything deferred is
 * already too late.
 */
export function ThemeScript(): React.ReactElement {
  const script = `(function(){try{var t=localStorage.getItem('sb-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}else{document.documentElement.setAttribute('data-theme',window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}}catch(e){}})()`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
