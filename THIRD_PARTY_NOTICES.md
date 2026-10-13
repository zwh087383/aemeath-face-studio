# Sources and third-party notices

This repository combines original experiment code with independently authored assets and software. It does not replace or extend the third-party notices below.

| Component | Source / notice location |
| --- | --- |
| Aemeath PMX character and textures | [Model distribution page](https://www.aplaybox.com/details/model/VAUBif86B0mu); original creator information and notice at `assets/Aemeath/使用说明 read me (CN, JP, EN).txt` |
| NVIDIA Audio2Face-3D-SDK | [Official repository](https://github.com/NVIDIA/Audio2Face-3D-SDK), pinned as a submodule; source headers retain NVIDIA's MIT notices |
| NVIDIA Audio2Face-3D-v2.3.1-Claire | [Official model repository](https://huggingface.co/nvidia/Audio2Face-3D-v2.3.1-Claire), pinned by revision and SHA256; original README / model notices downloaded with the model |
| CUDA and TensorRT | [NVIDIA CUDA redistributables](https://developer.download.nvidia.com/compute/cuda/redist/) and [NVIDIA TensorRT](https://developer.nvidia.com/tensorrt); binaries fetched from official locations, their notices retained in local runtime directories |
| Three.js | [Official repository](https://github.com/mrdoob/three), MIT; installed through npm lockfile |
| @takahirox/three-mmd | [Official repository](https://github.com/takahirox/three-mmd), MIT; npm package includes third-party notices |
| mmd-parser | [Official repository](https://github.com/takahirox/mmd-parser), MIT; installed through npm lockfile |

The Chinese demo audio was generated locally with the installed Microsoft Huihui Desktop voice for this experiment. Character resources are the original local files, not generated replacements. The PMX SHA256 is `79b622d0a87ab61516d2c3008d241d9145daa905acbcbd29d070c68cc55fa437`.

Raw CUDA/TensorRT distributions, model weights, local caches, generated TensorRT engines, and installed npm packages are not included in Git; reproducible retrieval/build scripts and pinned manifests are included.
