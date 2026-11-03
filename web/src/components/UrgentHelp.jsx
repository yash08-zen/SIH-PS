import { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import { speech } from '../speech/speech.js';
import Icon from './Icon.jsx';

// Fixed at the bottom of every patient screen. One tap tells staff the patient needs help now: with a live session it raises an emergency alert on
// their case, otherwise staff get an urgent help request. The note beside it is always visible, because the software cannot know every emergency.
export default function UrgentHelp({ screen }) {
  const { t, lang } = useI18n();
  const [state, setState] = useState('idle'); // idle | sending | sent | failed

  const press = async () => {
    setState('sending');
    try {
      const r = await api('/patient/urgent', { method: 'POST', body: { screen } });
      const ok = r.ok;
      setState(ok ? 'sent' : 'failed');
      speech.speak(t(ok ? 'urgent.sent' : 'urgent.failed'), lang);
    } catch {
      setState('failed');
      speech.speak(t('urgent.failed'), lang);
    }
  };

  return (
    <aside className={`urgent-bar is-${state}`} aria-label={t('urgent.label')}>
      <p className="urgent-note"><Icon name="help" size={22} /> {state === 'sent' ? t('urgent.sent') : state === 'failed' ? t('urgent.failed') : t('urgent.note')}</p>
      <button type="button" className="urgent-button" onClick={press} disabled={state === 'sending'}>
        {state === 'sent' ? t('urgent.again') : t('urgent.button')}
      </button>
      <span role="status" className="sr-only">{state === 'sent' ? t('urgent.sent') : ''}</span>
    </aside>
  );
}
