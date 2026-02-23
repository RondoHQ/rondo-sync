(function () {
  const source = '/public/rondo_logo.svg';
  const size = 64;
  const intervalMs = 100;
  const degreesPerSecond = 18; // 20s per full rotation
  const stepDegrees = (degreesPerSecond * intervalMs) / 1000;
  const iconId = 'rotating-favicon';

  function removeStaticIconLinks() {
    const links = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
    links.forEach((link) => {
      if (link.id !== iconId) {
        link.remove();
      }
    });
  }

  function setFavicon(href) {
    const existing = document.getElementById(iconId);
    if (existing) {
      existing.remove();
    }

    const link = document.createElement('link');
    link.id = iconId;
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = href;
    document.head.appendChild(link);
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const image = new Image();
  let angle = 0;

  function draw() {
    if (document.hidden) return;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(image, -size / 2, -size / 2, size, size);
    ctx.restore();

    setFavicon(canvas.toDataURL('image/png'));
    angle = (angle + stepDegrees) % 360;
  }

  image.onload = function () {
    removeStaticIconLinks();
    draw();
    setInterval(draw, intervalMs);
  };

  image.src = source;
})();
