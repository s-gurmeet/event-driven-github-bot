// Landing page JS — animated terminal, smooth scroll
(function () {
  'use strict';

  // Check if user is already logged in
  fetch('/auth/me')
    .then(r => r.json())
    .then(data => {
      if (data.authenticated) {
        // Update CTA buttons if logged in
        document.querySelectorAll('a[href="/auth/github"]').forEach(btn => {
          btn.href = '/dashboard';
          btn.textContent = '';
          btn.innerHTML = '<span>Go to Dashboard →</span>';
        });
      }
    })
    .catch(() => {}); // ignore

  // Animate terminal log lines with staggered delay
  const logLines = document.querySelectorAll('#demo-log .log-line');
  logLines.forEach((line, i) => {
    line.style.opacity = '0';
    setTimeout(() => {
      line.style.opacity = '1';
    }, i * 300 + 400);
  });

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      const target = document.querySelector(link.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Intersection Observer for feature cards animation
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1 }
  );

  document.querySelectorAll('.feature-card, .step').forEach((el, i) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = `opacity 0.5s ease ${i * 0.08}s, transform 0.5s ease ${i * 0.08}s`;
    observer.observe(el);
  });
})();
