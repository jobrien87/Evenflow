import { useEffect, useRef } from 'react';
import { api } from './api';
import { fireCelebration } from './celebrations';

// A per-viewer-only dedupe so the same celebration never pops twice in one
// day (survives remounts/refreshes, never shared across devices or synced
// back to the server — exactly the localStorage convention this app uses
// for every other per-viewer convenience).
function alreadyShownToday(storageKey) {
  try {
    return localStorage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}
function markShownToday(storageKey) {
  try {
    localStorage.setItem(storageKey, '1');
  } catch {
    // per-viewer convenience only — fine if storage is unavailable
  }
}

// Fires the three account-level celebration moments — a brand new user's
// very first login, a logged-in user's birthday, and (new) their work
// anniversary — once each per day, driven by real fields (User.
// firstLoginCelebratedAt, User.birthday, HrEmployeeProfile.hireDate),
// never a manual per-visit trigger. Mounted once from AppLayout via
// <AccountCelebrations user={user} /> below.
export default function useAccountCelebrations(user) {
  const ranForUserId = useRef(null);

  useEffect(() => {
    if (!user || ranForUserId.current === user.id) return;
    ranForUserId.current = user.id;

    if (!user.firstLoginCelebratedAt) {
      fireCelebration('CONFETTI', { message: `Welcome to EvenFlow, ${user.firstName}!` });
      api.completeFirstLoginCelebration().catch(() => {
        // Non-fatal — worst case it celebrates again next login.
      });
    }

    if (user.birthday) {
      const today = new Date();
      const bday = new Date(user.birthday);
      const isBirthdayToday = bday.getUTCMonth() === today.getMonth() && bday.getUTCDate() === today.getDate();
      if (isBirthdayToday) {
        const todayKey = today.toISOString().slice(0, 10);
        const storageKey = `birthday_celebrated_${user.id}_${todayKey}`;
        if (!alreadyShownToday(storageKey)) {
          fireCelebration('CONFETTI', {
            // The real DOB/birth year/age are never part of this text —
            // only the day itself is celebrated, same as the roster's own
            // "upcoming birthdays" list, which also never shows age.
            popup: { title: 'HAPPY BIRTHDAY!', body: `Happy birthday, ${user.firstName}! Everyone here hopes you have a great one. 🎉` },
          });
          markShownToday(storageKey);
        }
      }
    }

    // Work anniversary — requires their own HR employee profile's hireDate,
    // which isn't on the plain user object, so this is a best-effort fetch:
    // no HR profile, no hireDate, or HR not enabled/reachable for this
    // agency all fail silently and simply skip the celebration (respects
    // HR access/permissions rather than erroring the whole page over it).
    api.hrEmployeeMe().then((data) => {
      const hireDate = data?.employee?.hireDate;
      if (!hireDate) return;
      const today = new Date();
      const hired = new Date(hireDate);
      const isAnniversaryToday = hired.getUTCMonth() === today.getUTCMonth() && hired.getUTCDate() === today.getUTCDate();
      const years = today.getUTCFullYear() - hired.getUTCFullYear();
      if (isAnniversaryToday && years > 0) {
        const todayKey = today.toISOString().slice(0, 10);
        const storageKey = `anniversary_celebrated_${user.id}_${todayKey}`;
        if (!alreadyShownToday(storageKey)) {
          fireCelebration('CONFETTI', {
            // Years of service is not birth-related PII — only DOB/birth
            // year/age are kept out of a celebration, per the same rule
            // the birthday popup above follows.
            popup: { title: 'HAPPY WORK ANNIVERSARY!', body: `Happy ${years}-year anniversary, ${user.firstName}! Thanks for everything you bring to the team. 🎉` },
          });
          markShownToday(storageKey);
        }
      }
    }).catch(() => {
      // No HR profile, HR not enabled, or not reachable — never fatal.
    });
  }, [user]);
}
