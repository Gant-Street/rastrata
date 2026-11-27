/** Hand a file the page holds to the browser to save, under this name. The browser's own download, with nothing sent anywhere: an object URL for the bytes, one click on a link
 * that is never shown, and the URL released a little later. */
export function saveFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
