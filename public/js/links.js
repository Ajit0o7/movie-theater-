// Checks a pasted "video link" before everyone's player tries it, turning the common silent
// failures into a clear message (or a fixed link).

/**
 * @param {string} input   what the user pasted
 * @param {string} pageProtocol  location.protocol of this page ('https:' when deployed)
 * @returns {{ url?: string, error?: string, note?: string }}
 */
export function checkVideoLink(input, pageProtocol) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return { error: 'That isn’t a valid link. Paste the full address, starting with https://' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http(s) video links can be played.' };

  const host = url.hostname.replace(/^www\./, '');

  // Share pages, not video files.
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    return {
      error:
        'Google Drive links open a web page, not the video file, and Drive limits streaming, so they can’t be played here. Download the file and use “Same file everywhere” or “Stream a file”.',
    };
  }
  if (host === 'dropbox.com' && /^\/(s|scl)\//.test(url.pathname)) {
    // ?dl=0 is the preview page; ?raw=1 serves the file itself (with range support).
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return { url: url.toString(), note: 'Turned the Dropbox share link into a direct video link.', ...mixed(url, pageProtocol) };
  }
  if (host === '1drv.ms' || host === 'onedrive.live.com' || host === 'mega.nz') {
    return { error: 'That’s a share page, not a video file. Use a direct link to the file, or download it and use “Same file everywhere”.' };
  }
  return { url: url.toString(), ...mixed(url, pageProtocol) };
}

/** An https page may not load http:// media (mixed content); browsers block it silently. */
function mixed(url, pageProtocol) {
  if (pageProtocol === 'https:' && url.protocol === 'http:') {
    return {
      error: `This site uses https://, so browsers block http:// videos. Use the https:// version of the link (try ${url.toString().replace(/^http:/, 'https:')}), or a host that supports https.`,
    };
  }
  return {};
}
