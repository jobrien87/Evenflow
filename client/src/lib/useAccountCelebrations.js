import { useEffect, useRef } from 'react';
import { api } from './api';
import { fireCelebration } from './celebrations';

// Fires the two account-level celebration moments — a brand new user's
// very first login, and a logged-in user's birthday — once each, driven
// by real fields on the user record (User.firstLoginCelebratedAt,
// User.birthday), never a manual per-visit trigger. Mounted once from
// AppLayout via <AccountCelebrations user={user} /> below.
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
        let alreadyShownToday = false;
        try {
          alreadyShownToday = localStorage.getItem(storageKey) === '1';
        } catch {
          // no persisted memory of today's celebration — just show it
        }
        if (!alreadyShownToday) {
          fireCelebration('CONFETTI', {
            popup: { title: 'HAPPY BIRTHDAY!', body: `Happy birthday, ${user.firstName}! Everyone here hopes you have a great one. 🎉` },
          });
          try {
            localStorage.setItem(storageKey, '1');
          } catch {
            // per-viewer convenience only — fine if storage is unavailable
          }
        }
      }
    }
  }, [user]);
}
