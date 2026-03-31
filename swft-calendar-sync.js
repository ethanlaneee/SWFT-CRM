// ════════════════════════════════════════════════
// SWFT Calendar Sync
// Generates .ics files for Google/Apple Calendar
// Include via: <script src="swft-calendar-sync.js"></script>
// ════════════════════════════════════════════════

(function () {
  // Generate ICS content for a job
  function generateICS(job) {
    const now = new Date();
    const uid = 'swft-' + Date.now() + '@swft-crm';

    // Parse date - supports YYYY-MM-DD or text dates
    let startDate;
    if (job.date && job.date.match(/^\d{4}-\d{2}-\d{2}/)) {
      startDate = new Date(job.date + 'T' + (job.time || '09:00') + ':00');
    } else {
      startDate = new Date(job.date || now);
    }

    // Default 2 hour duration
    const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SWFT CRM//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + uid,
      'DTSTART:' + fmt(startDate),
      'DTEND:' + fmt(endDate),
      'SUMMARY:' + (job.title || 'SWFT Job'),
      'DESCRIPTION:' + (job.description || job.service || ''),
      'LOCATION:' + (job.address || ''),
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    return ics;
  }

  // Download .ics file
  window.downloadCalendarEvent = function (job) {
    const ics = generateICS(job);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (job.title || 'swft-job').replace(/[^a-zA-Z0-9]/g, '_') + '.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') showToast('Calendar event downloaded');
  };

  // Open Google Calendar create event URL
  window.addToGoogleCalendar = function (job) {
    let startDate;
    if (job.date && job.date.match(/^\d{4}-\d{2}-\d{2}/)) {
      startDate = new Date(job.date + 'T' + (job.time || '09:00') + ':00');
    } else {
      startDate = new Date(job.date || new Date());
    }
    const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: job.title || 'SWFT Job',
      dates: fmt(startDate) + '/' + fmt(endDate),
      details: job.description || job.service || 'Created by SWFT CRM',
      location: job.address || '',
    });

    window.open('https://calendar.google.com/calendar/render?' + params.toString(), '_blank');
  };
})();
