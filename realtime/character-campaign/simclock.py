"""Advance idle scheduling and real emotion equations, never provider/audio time."""
import time

class IdleClock:
    def __init__(self,gaps,*,wall=time.time,monotonic=time.monotonic):
        self.wall=wall;self.monotonic=monotonic;self.offset=0.0
        self.gaps=list(gaps);self.current=None;self.receipts=[]
    def now(self):return self.wall()+self.offset
    def begin(self,index):
        if type(index) is not int or not 0<=index<len(self.gaps):raise ValueError('unknown_idle_gap')
        if self.current and self.current['index']==index:return self.snapshot()
        if self.current and self.snapshot()['logicalElapsedSeconds']<self.current['targetSeconds']-.05:raise ValueError('previous_gap_incomplete')
        if self.current and index!=self.current['index']+1:raise ValueError('nonsequential_idle_gap')
        if self.current is None and index!=0:raise ValueError('first_gap_required')
        self.current={'index':index,'targetSeconds':self.gaps[index],'realStart':self.monotonic(),'offsetStart':self.offset}
        return self.snapshot()
    def snapshot(self):
        if not self.current:return {'gap':None,'offsetSeconds':self.offset}
        c=self.current;real=max(0,self.monotonic()-c['realStart'])
        return {'gap':c['index'],'targetSeconds':c['targetSeconds'],'realElapsedSeconds':real,
                'logicalElapsedSeconds':real+self.offset-c['offsetStart'],'offsetSeconds':self.offset}
    def step(self,index,*,hold=False):
        if not self.current or self.current['index']!=index:raise ValueError('idle_gap_not_started')
        before=self.snapshot()
        # At most 10x elapsed real time, at most 12 logical seconds per tick.
        desired=min(before['targetSeconds'],before['realElapsedSeconds']*10)
        extra=0 if hold else min(12,max(0,desired-before['logicalElapsedSeconds']))
        self.offset+=extra
        result={**self.snapshot(),'advancedSeconds':extra,'heldForRealWork':bool(hold)}
        self.receipts.append(result);return result
