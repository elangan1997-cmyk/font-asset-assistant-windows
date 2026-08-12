#!/usr/bin/env python3
"""Patch OCR boxes from a locally sampled background, without content-aware bleed."""
from __future__ import annotations
import argparse, json
from pathlib import Path
import cv2, numpy as np

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True,type=Path); ap.add_argument('--output',required=True,type=Path); ap.add_argument('--lines',required=True); ap.add_argument('--pad',type=int,default=12)
    a=ap.parse_args(); img=cv2.imread(str(a.input),cv2.IMREAD_COLOR); out=img.copy(); h,w=img.shape[:2]
    for line in json.loads(a.lines):
        x=max(0,int(line['x'])); y=max(0,int(line['y'])); x2=min(w,int(line['x']+line['width'])); y2=min(h,int(line['y']+line['height'])); p=a.pad
        samples=[]
        for xa,ya,xb,yb in [(max(0,x-p),max(0,y-p),min(w,x2+p),max(0,y)),(max(0,x-p),min(h,y2),min(w,x2+p),min(h,y2+p)),(max(0,x-p),y,min(w,x),y2),(min(w,x2),y,min(w,x2+p),y2)]:
            if xb>xa and yb>ya: samples.append(img[ya:yb,xa:xb].reshape(-1,3))
        if not samples: continue
        color=np.median(np.concatenate(samples,axis=0),axis=0).astype(np.uint8)
        out[y:y2,x:x2]=color
        # soften the patch edges with a narrow blur only inside the OCR box
        out[y:y2,x:x2]=cv2.GaussianBlur(out[y:y2,x:x2],(0,0),1.2)
    a.output.parent.mkdir(parents=True,exist_ok=True); cv2.imwrite(str(a.output),out); print(json.dumps({'output':str(a.output),'qa':'needs_review'}))
if __name__=='__main__': main()
