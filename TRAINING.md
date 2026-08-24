# Accuracy upgrade
The included baseline is a real/fake Wav2Vec2 detector plus a weak complementary spectral score. It is NOT a 99% real-world guarantee.

For a serious detector, train on diverse, legally usable datasets such as ASVspoof 5, In-the-Wild and SpeechFake, while keeping a completely held-out generator-disjoint test set. ASVspoof 5 explicitly targets generalized countermeasures against unseen attack methods. In-the-Wild is a cross-domain benchmark. SpeechFake contains over 3 million fake samples across 46 languages from 30 open-source generators.

Do not train on evaluation data. Do not report random clip-split accuracy as real-world accuracy. Track EER, ROC-AUC, F1, false-human rate and false-AI rate, and test unseen generators and compressed/noisy audio.

The existing 50 GB should be used for diversity, augmentation and held-out testing, not simply maximum volume.
