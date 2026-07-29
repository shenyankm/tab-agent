import { useState } from 'react';
import { Zap, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="font-head text-2xl">Pixel Agent</h1>

      <div className="flex items-center gap-3">
        <Button onClick={() => setCount((c) => c + 1)}>
          <Zap />
          Count: {count}
        </Button>
        <Button variant="destructive" size="icon" onClick={() => setCount(0)}>
          <Trash2 />
        </Button>
      </div>

    </div>
  );
}

export default App;
