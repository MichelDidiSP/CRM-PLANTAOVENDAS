import { createContext, useContext, useState, type ReactNode } from 'react';

type SimContextType = {
  simulatedTime: string | null; // formato "HH:MM" ou null = usar hora real
  setSimulatedTime: (time: string | null) => void;
  testMode: boolean;
  setTestMode: (on: boolean) => void;
  /** Retorna a hora actual (simulada ou real) como objeto Date */
  getCurrentTime: () => Date;
  /** Duração da chamada em segundos, conforme o modo de teste */
  callDuration: number;
};

const SimContext = createContext<SimContextType | null>(null);

export function SimProvider({ children }: { children: ReactNode }) {
  const [simulatedTime, setSimulatedTime] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);

  function getCurrentTime(): Date {
    if (!simulatedTime) return new Date();
    const [h, m] = simulatedTime.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  const callDuration = testMode ? 20 : 120;

  return (
    <SimContext.Provider
      value={{ simulatedTime, setSimulatedTime, testMode, setTestMode, getCurrentTime, callDuration }}
    >
      {children}
    </SimContext.Provider>
  );
}

export function useSim(): SimContextType {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error('useSim deve ser usado dentro de SimProvider');
  return ctx;
}
